/**
 * SMTP email via nodemailer (lazy-required so shared still loads if optional dep missing).
 */
function getTransport(keys) {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    throw new Error('nodemailer is not installed — run npm install in backend/');
  }
  const port = +(keys.port || 587);
  return nodemailer.createTransport({
    host: keys.host,
    port,
    secure: port === 465,
    auth: keys.user ? { user: keys.user, pass: keys.password } : undefined,
  });
}

async function testConnection(keys) {
  const { host, port, user, password, from } = keys || {};
  if (!host || !from) throw new Error('SMTP host and From address are required');
  if (user && !password) throw new Error('SMTP password is required when username is set');
  const transport = getTransport(keys);
  await transport.verify();
  return { ok: true, provider: 'smtp', host, port: +(port || 587), from };
}

async function send(keys, { to, subject, text, html }) {
  if (!to || (!text && !html)) throw new Error('Email requires to and text/html');
  const transport = getTransport(keys);
  const info = await transport.sendMail({
    from: keys.from,
    to,
    subject: subject || 'CraveDash',
    text: text || undefined,
    html: html || undefined,
  });
  return { messageId: info.messageId, accepted: info.accepted };
}

module.exports = { testConnection, send };
