const { unauthorized, forbidden } = require('./errors');
const { verifyEposStaff } = require('./jwt');

/**
 * An EPOS till may write a catalogue or CRM path only with a valid staff PIN session: the X-Epos-Staff-Token from
 * POST /epos/pin/verify, for the same restaurant. Returns the staff claims.
 */
function requireEposStaffSession(req) {
  const raw = req.headers['x-epos-staff-token'];
  if (!raw) {
    throw unauthorized('Staff PIN session required: send X-Epos-Staff-Token from POST /epos/pin/verify');
  }
  let claims;
  try {
    claims = verifyEposStaff(String(raw));
  } catch {
    throw unauthorized('Staff session is invalid or expired. Verify the PIN again');
  }
  if (claims.restaurant_id && req.user?.restaurant_id && String(claims.restaurant_id) !== String(req.user.restaurant_id)) {
    throw forbidden('Staff session belongs to another restaurant');
  }
  return claims;
}

module.exports = { requireEposStaffSession };
