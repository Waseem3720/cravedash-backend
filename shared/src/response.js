function ok(res, data, meta) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.json(body);
}

function created(res, data) {
  return res.status(201).json({ success: true, data });
}

function fail(res, err) {
  const status = err.status || 500;
  const error = {
    code: err.code || 'INTERNAL_ERROR',
    message: err.message || 'Internal server error',
  };
  // Structured detail for refusals such as 409 dependants (SEC-M8). Only set by the server, never echoed input.
  if (err.details !== undefined) error.details = err.details;
  return res.status(status).json({ success: false, error });
}

module.exports = { ok, created, fail };
