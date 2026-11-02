const { forbidden } = require('@cravedash/shared/src/errors');
const { requireEposStaffSession } = require('@cravedash/shared/src/eposStaffWrite');

/**
 * EPOS may read settings/blobs; mutations reserved for restaurant/super (prefs OK).
 *
 * Matching uses the request PATH only (req.path, query string excluded). The earlier version
 * also matched the full original URL, so a query string such as "?x=/integrations/" could open
 * any route to an EPOS session (see audit 04 S-05 and S-20).
 *
 * Integration settings are deliberately NOT open to EPOS (decision D2). Notifications are NOT open to EPOS
 * either: decision D-H is not made, and the approved default is "not allowed until decided" (SEC-H1).
 */
const EPOS_OPEN_WRITE_PATHS = [
  '/print/', '/callerid/',
  // BUG-020: a till may debit a wallet and redeem points for a sale. Earning points stays with the restaurant admin.
  '/engines/inventory/deduct', '/engines/wallet/debit', '/engines/loyalty/redeem',
  '/engines/terminals/charge', '/engines/couriers/', '/engines/marketplaces/',
];

/** Blob keys the till itself writes (call and print logs). Every other blob write is refused for EPOS. */
const EPOS_BLOB_WRITE_PATHS = [
  '/blobs/calls_live', '/blobs/call_log', '/blobs/call_seq', '/blobs/print_log', '/blobs/print_queue',
];

function eposReadOnly(req, res, next) {
  if (req.user?.role === 'epos' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const path = req.path || '';
    // Prefix match for route families (paths are relative to /api/v1); exact match for single blob keys.
    if (EPOS_OPEN_WRITE_PATHS.some((p) => path.startsWith(p))) return next();
    if (path === '/settings/prefs') return next();
    if (EPOS_BLOB_WRITE_PATHS.some((p) => path === p)) return next();
    // EPOS spec: a till may create, edit and remove a customer with a staff PIN session.
    if (path === '/customers' || path.startsWith('/customers/')) {
      try {
        requireEposStaffSession(req);
        return next();
      } catch (err) {
        return next(err);
      }
    }
    return next(forbidden('EPOS role cannot modify restaurant admin data'));
  }
  return next();
}

module.exports = { eposReadOnly, EPOS_OPEN_WRITE_PATHS, EPOS_BLOB_WRITE_PATHS };
