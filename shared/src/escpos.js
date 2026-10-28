const net = require('net');

/** Minimal ESC/POS helpers for network thermal printers + cash drawer. */
function encodeText(htmlOrText, { cut = true, drawer = false } = {}) {
  const text = String(htmlOrText || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();

  const chunks = [];
  chunks.push(Buffer.from([0x1b, 0x40])); // init
  chunks.push(Buffer.from([0x1b, 0x74, 0x00])); // code page
  chunks.push(Buffer.from(text + '\n\n', 'utf8'));
  if (cut) chunks.push(Buffer.from([0x1d, 0x56, 0x00])); // full cut
  if (drawer) chunks.push(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])); // drawer kick pin 2
  return Buffer.concat(chunks);
}

function drawerKick() {
  return Buffer.from([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa]);
}

function sendTcp(host, port, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    socket.setTimeout(timeoutMs);
    socket.once('error', fail);
    socket.once('timeout', () => fail(new Error(`Printer timeout ${host}:${port}`)));
    socket.connect(port, host, () => {
      socket.write(payload, (err) => {
        if (err) return fail(err);
        socket.end(() => {
          if (done) return;
          done = true;
          resolve({ ok: true, host, port, bytes: payload.length });
        });
      });
    });
  });
}

async function printNetwork(printer, htmlOrText, opts = {}) {
  const address = String((printer && printer.address) || '').trim();
  if (!address || address.toUpperCase() === 'USB') {
    throw new Error('Network printer address required (e.g. 192.168.1.50 or 192.168.1.50:9100)');
  }
  let host = address;
  let port = 9100;
  if (address.includes(':')) {
    const [h, p] = address.split(':');
    host = h;
    port = +(p || 9100);
  }
  const buf = encodeText(htmlOrText, {
    cut: printer.cut !== false,
    drawer: !!(opts.drawer || printer.drawer),
  });
  return sendTcp(host, port, buf);
}

async function openDrawerNetwork(printer) {
  const address = String((printer && printer.address) || '').trim();
  if (!address || address.toUpperCase() === 'USB') {
    throw new Error('Cash drawer needs a network receipt printer address, or a local print agent for USB');
  }
  let host = address;
  let port = 9100;
  if (address.includes(':')) {
    const [h, p] = address.split(':');
    host = h;
    port = +(p || 9100);
  }
  return sendTcp(host, port, drawerKick());
}

module.exports = { encodeText, drawerKick, sendTcp, printNetwork, openDrawerNetwork };
