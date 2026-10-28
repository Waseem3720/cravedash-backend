#!/usr/bin/env node
/**
 * CraveDash local print agent — run on each till PC (USB + LAN ESC/POS).
 *
 *   node tools/print-agent/index.js
 *   PRINT_AGENT_PORT=9108 PRINT_AGENT_KEY=secret node tools/print-agent/index.js
 *
 * In the browser till: localStorage.setItem('cd_print_agent', 'http://127.0.0.1:9108')
 */
const http = require('http');
const { printNetwork, openDrawerNetwork, encodeText, sendTcp, drawerKick } = require('../../shared/src/escpos');

const PORT = +(process.env.PRINT_AGENT_PORT || 9108);
const KEY = process.env.PRINT_AGENT_KEY || '';

function auth(req) {
  if (!KEY) return true;
  return req.headers['x-print-agent-key'] === KEY;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Print-Agent-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(raw);
}

async function doPrint(body) {
  const printer = body.printer || {};
  const html = body.html || body.title || ' ';
  const copies = Math.max(1, Math.min(5, +(body.copies || 1)));
  const conn = String(printer.connection || '').toLowerCase();
  const addr = String(printer.address || '');

  if (conn === 'network' || /^\d+\.\d+\.\d+\.\d+/.test(addr)) {
    let last;
    for (let i = 0; i < copies; i++) {
      last = await printNetwork(printer, html, { drawer: !!body.drawer && i === 0 });
    }
    return last;
  }

  // USB: try raw TCP to a virtual COM bridge if address looks like host:port,
  // otherwise write ESC/POS to stdout for pipe to /dev/usb/lp0
  if (addr.includes(':') && !addr.toUpperCase().startsWith('USB')) {
    const [host, port] = addr.split(':');
    const buf = encodeText(html, { cut: printer.cut !== false, drawer: !!body.drawer });
    return sendTcp(host, +(port || 9100), buf);
  }

  // Fallback: expose payload for OS spooler / raw USB helper
  const buf = encodeText(html, { cut: printer.cut !== false, drawer: !!body.drawer });
  if (process.env.PRINT_USB_DEVICE) {
    const fs = require('fs');
    fs.writeFileSync(process.env.PRINT_USB_DEVICE, buf);
    return { ok: true, via: 'usb_device', device: process.env.PRINT_USB_DEVICE, bytes: buf.length };
  }
  return {
    ok: true,
    via: 'buffer',
    bytes: buf.length,
    hint: 'Set PRINT_USB_DEVICE=/dev/usb/lp0 (Linux) or use a network printer address',
    payload_b64: buf.toString('base64'),
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.url === '/health') return json(res, 200, { ok: true, service: 'cravedash-print-agent' });
  if (!auth(req)) return json(res, 401, { error: 'Unauthorized' });

  try {
    if (req.method === 'POST' && req.url === '/print') {
      const body = await readJson(req);
      const result = await doPrint(body);
      return json(res, 200, { ok: true, result });
    }
    if (req.method === 'POST' && req.url === '/drawer') {
      const body = await readJson(req);
      const printer = body.printer || {};
      if (printer.connection === 'network' || /^\d+\.\d+\.\d+\.\d+/.test(String(printer.address || ''))) {
        const result = await openDrawerNetwork(printer);
        return json(res, 200, { ok: true, result });
      }
      if (process.env.PRINT_USB_DEVICE) {
        const fs = require('fs');
        fs.writeFileSync(process.env.PRINT_USB_DEVICE, drawerKick());
        return json(res, 200, { ok: true, via: 'usb_device' });
      }
      return json(res, 200, { ok: true, via: 'buffer', hint: 'Drawer kick buffered — set network printer or PRINT_USB_DEVICE' });
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    json(res, 500, { error: err.message || 'Print agent error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[print-agent] http://127.0.0.1:${PORT}`);
  console.log('[print-agent] In EPOS console: localStorage.setItem("cd_print_agent","http://127.0.0.1:' + PORT + '")');
});
