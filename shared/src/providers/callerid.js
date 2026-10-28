/**
 * Soft CLI via Twilio Voice — webhook posts CallSid + From into calls_live.
 */
async function testConnection(keys) {
  const { provider, server, username, password, number } = keys || {};
  if (!number) throw new Error('Shop phone number is required');
  if (/twilio/i.test(String(provider || ''))) {
    if (!username || !password) throw new Error('Twilio Account SID (username) and Auth Token (password) required');
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(username)}.json`,
      { headers: { Authorization: `Basic ${auth}` } },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Twilio Voice auth failed (${res.status})`);
    return { ok: true, provider: 'twilio_voice', number, account: data.friendly_name || username };
  }
  if (!server || !username || !password) {
    throw new Error('SIP server, username and password are required');
  }
  // Cannot dial SIP from cloud without a media bridge — validate config presence
  return {
    ok: true,
    provider: String(provider || 'sip'),
    server,
    number,
    note: 'SIP credentials saved. Point your softphone / PBX webhook to /api/v1/integrations/callerid/inbound',
  };
}

function normalizePhone(from) {
  if (!from) return '';
  const s = String(from).trim();
  if (s.toLowerCase() === 'anonymous' || s.toLowerCase() === 'unknown') return s;
  return s;
}

module.exports = { testConnection, normalizePhone };
