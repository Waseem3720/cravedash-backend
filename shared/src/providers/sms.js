/**
 * Twilio SMS adapter — REST API (no SDK required).
 */
async function twilioSend({ account_sid, auth_token, from }, { to, body }) {
  if (!account_sid || !auth_token || !from) {
    throw new Error('SMS keys incomplete (account_sid, auth_token, from)');
  }
  if (!to || !body) throw new Error('SMS requires to and body');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account_sid)}/Messages.json`;
  const auth = Buffer.from(`${account_sid}:${auth_token}`).toString('base64');
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error_message || `Twilio SMS failed (${res.status})`);
  }
  return { sid: data.sid, status: data.status, to: data.to };
}

async function testConnection(keys) {
  const { account_sid, auth_token, from } = keys || {};
  if (!account_sid || !auth_token || !from) {
    throw new Error('Fill Account SID, Auth token and Sender number');
  }
  const auth = Buffer.from(`${account_sid}:${auth_token}`).toString('base64');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account_sid)}.json`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Twilio auth failed (${res.status})`);
  }
  return {
    ok: true,
    provider: 'twilio',
    account: data.friendly_name || data.sid,
    from,
    status: data.status,
  };
}

module.exports = { testConnection, send: twilioSend };
