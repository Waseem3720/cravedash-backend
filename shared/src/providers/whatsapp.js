/**
 * Meta WhatsApp Cloud API.
 * Fields: phone_number_id, access_token, (optional) business_account_id
 */
async function testConnection(keys) {
  const { phone_number_id, access_token } = keys || {};
  if (!phone_number_id || !access_token) {
    throw new Error('WhatsApp phone_number_id and access_token are required');
  }
  const res = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(phone_number_id)}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data.error && data.error.message) || `WhatsApp API failed (${res.status})`);
  }
  return {
    ok: true,
    provider: 'whatsapp_cloud',
    display_phone: data.display_phone_number || data.verified_name || phone_number_id,
  };
}

async function send(keys, { to, text, template, language }) {
  const { phone_number_id, access_token } = keys || {};
  if (!phone_number_id || !access_token) throw new Error('WhatsApp keys incomplete');
  if (!to) throw new Error('WhatsApp requires to (E.164 without + preferred)');
  const toDigits = String(to).replace(/\D/g, '');
  let body;
  if (template) {
    body = {
      messaging_product: 'whatsapp',
      to: toDigits,
      type: 'template',
      template: {
        name: template,
        language: { code: language || 'en' },
      },
    };
  } else {
    if (!text) throw new Error('WhatsApp requires text or template');
    body = {
      messaging_product: 'whatsapp',
      to: toDigits,
      type: 'text',
      text: { body: text },
    };
  }
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${encodeURIComponent(phone_number_id)}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data.error && data.error.message) || `WhatsApp send failed (${res.status})`);
  }
  return { id: data.messages && data.messages[0] && data.messages[0].id, to: toDigits };
}

module.exports = { testConnection, send };
