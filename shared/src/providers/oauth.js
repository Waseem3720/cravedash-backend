/** Social login / reCAPTCHA credential validation */

async function googleLoginTest(keys) {
  const { client_id, client_secret } = keys || {};
  if (!client_id || !client_secret) throw new Error('Google client_id and client_secret are required');
  // Token endpoint with invalid code must return invalid_grant, not invalid_client
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id,
      client_secret,
      code: 'cravedash_health_check',
      grant_type: 'authorization_code',
      redirect_uri: 'https://localhost/oauth/callback',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error === 'invalid_client') {
    throw new Error('Google OAuth client_id/secret rejected');
  }
  return { ok: true, provider: 'google_login', detail: data.error || 'credentials accepted' };
}

async function facebookLoginTest(keys) {
  const { app_id, app_secret } = keys || {};
  if (!app_id || !app_secret) throw new Error('Facebook app_id and app_secret are required');
  const res = await fetch(
    `https://graph.facebook.com/oauth/access_token?client_id=${encodeURIComponent(app_id)}&client_secret=${encodeURIComponent(app_secret)}&grant_type=client_credentials`,
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error((data.error && data.error.message) || 'Facebook app credentials rejected');
  }
  return { ok: true, provider: 'facebook_login', app_id };
}

async function appleLoginTest(keys) {
  const { service_id, team_id, key_id, private_key } = keys || {};
  if (!service_id || !team_id || !key_id || !private_key) {
    throw new Error('Apple service_id, team_id, key_id and private_key are required');
  }
  if (!/BEGIN PRIVATE KEY/.test(private_key) && !/BEGIN EC PRIVATE KEY/.test(private_key)) {
    throw new Error('Apple private_key must be a .p8 PEM');
  }
  // Structural validation — full JWT client_secret minting happens at login time
  return { ok: true, provider: 'apple_login', service_id, team_id, key_id };
}

async function recaptchaTest(keys) {
  const { site_key, secret_key } = keys || {};
  if (!site_key || !secret_key) throw new Error('reCAPTCHA site_key and secret_key are required');
  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: secret_key, response: 'cravedash_health' }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  // invalid-input-response means secret was accepted; bad-request / invalid-input-secret = fail
  const errs = data['error-codes'] || [];
  if (errs.includes('invalid-input-secret') || errs.includes('invalid-keys')) {
    throw new Error('reCAPTCHA secret_key rejected');
  }
  return { ok: true, provider: 'recaptcha', site_key, detail: errs[0] || 'secret accepted' };
}

module.exports = {
  google_login: { testConnection: googleLoginTest },
  facebook_login: { testConnection: facebookLoginTest },
  apple_login: { testConnection: appleLoginTest },
  recaptcha: { testConnection: recaptchaTest },
};
