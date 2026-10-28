/**
 * Firebase Cloud Messaging — legacy server key (HTTP) or service-account JSON (HTTP v1).
 * Keys UI may provide: project_id, server_key, sender_id, and/or service_account_json.
 */
async function getAccessTokenFromServiceAccount(sa) {
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const unsigned = `${header}.${claim}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(sa.private_key, 'base64url');
  const jwt = `${unsigned}.${signature}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'FCM service-account token failed');
  }
  return data.access_token;
}

function parseServiceAccount(keys) {
  const raw = keys.service_account_json || keys.service_file_content;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Firebase service account JSON is invalid');
  }
}

async function testConnection(keys) {
  const k = keys || {};
  const sa = parseServiceAccount(k);
  if (sa) {
    const token = await getAccessTokenFromServiceAccount(sa);
    const project = k.project_id || sa.project_id;
    if (!project) throw new Error('project_id is required with service account');
    // Dry-run validate by hitting projects endpoint shape — send to invalid token should 404 not 401
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project)}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          validate_only: true,
          message: { topic: 'cravedash_health', notification: { title: 'CraveDash', body: 'ok' } },
        }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      throw new Error((data.error && data.error.message) || 'FCM credentials rejected');
    }
    // 400 with INVALID_ARGUMENT on topic is still auth-ok
    return { ok: true, provider: 'fcm_v1', project_id: project };
  }
  if (!k.server_key) throw new Error('Provide FCM server key or service account JSON');
  const res = await fetch('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: {
      Authorization: `key=${k.server_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dry_run: true,
      to: '/topics/cravedash_health',
      notification: { title: 'CraveDash', body: 'ok' },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data.error) throw new Error(String(data.error));
  if (data.failure && !data.success && data.results && data.results[0] && /Invalid|Unauthorized/i.test(JSON.stringify(data))) {
    throw new Error(data.results[0].error || 'FCM server key rejected');
  }
  return { ok: true, provider: 'fcm_legacy', project_id: k.project_id || null };
}

async function send(keys, { tokens, topic, title, body, data }) {
  const k = keys || {};
  const sa = parseServiceAccount(k);
  const notification = { title: title || 'CraveDash', body: body || '' };
  if (sa) {
    const access = await getAccessTokenFromServiceAccount(sa);
    const project = k.project_id || sa.project_id;
    const message = { notification, data: data || undefined };
    if (topic) message.topic = topic;
    else if (tokens && tokens.length === 1) message.token = tokens[0];
    else if (tokens && tokens.length) message.token = tokens[0]; // batch via loop below
    else throw new Error('Push requires topic or device tokens');

    const results = [];
    const targets = topic ? [null] : (tokens || []);
    if (topic) {
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project)}/messages:send`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { topic, notification, data } }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json.error && json.error.message) || `FCM send failed (${res.status})`);
      results.push(json);
    } else {
      for (const token of targets) {
        const res = await fetch(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project)}/messages:send`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: { token, notification, data } }),
          },
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json.error && json.error.message) || `FCM send failed (${res.status})`);
        results.push(json);
      }
    }
    return { sent: results.length, results };
  }

  if (!k.server_key) throw new Error('Firebase keys incomplete');
  const payload = { notification, data: data || undefined };
  if (topic) payload.to = `/topics/${topic}`;
  else if (tokens && tokens.length === 1) payload.to = tokens[0];
  else if (tokens && tokens.length) payload.registration_ids = tokens;
  else throw new Error('Push requires topic or device tokens');

  const res = await fetch('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: {
      Authorization: `key=${k.server_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `FCM failed (${res.status})`);
  return json;
}

module.exports = { testConnection, send };
