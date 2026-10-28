class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function notFound(message = 'Not found') {
  return new AppError(message, 404, 'NOT_FOUND');
}

function unauthorized(message = 'Unauthorized') {
  return new AppError(message, 401, 'UNAUTHORIZED');
}

function forbidden(message = 'Forbidden') {
  return new AppError(message, 403, 'FORBIDDEN');
}

function badRequest(message = 'Bad request') {
  return new AppError(message, 400, 'BAD_REQUEST');
}

function conflict(message = 'Conflict') {
  return new AppError(message, 409, 'CONFLICT');
}

module.exports = { AppError, notFound, unauthorized, forbidden, badRequest, conflict };
