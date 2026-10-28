/**
 * Bind address for HTTP servers.
 * - Internal microservices: loopback in production (gateway is the public edge).
 * - Gateway: 0.0.0.0 by default so reverse proxies can reach it.
 * Override with LISTEN_HOST / GATEWAY_LISTEN_HOST.
 */
function listenHost({ gateway = false } = {}) {
  if (gateway) {
    return process.env.GATEWAY_LISTEN_HOST || process.env.LISTEN_HOST || '0.0.0.0';
  }
  if (process.env.LISTEN_HOST) return process.env.LISTEN_HOST;
  return process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0';
}

module.exports = { listenHost };
