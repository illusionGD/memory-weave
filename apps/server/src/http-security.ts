import type { NextFunction, Request, Response } from 'express';
import type { RequestHandler } from 'express';

/**
 * Protects cookie-based writes from a different browser origin.
 * @param allowedOrigin Configured browser origin, including its port.
 * @returns Express middleware for API requests.
 */
export function createOriginCheck(allowedOrigin: string): RequestHandler {
  return function checkOrigin(request: Request, response: Response, next: NextFunction): void {
    const path = request.path.toLowerCase();
    if (path === '/api' || path.startsWith('/api/')) {
      response.setHeader('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        const origin = request.get('origin');
        if (origin !== undefined && origin !== allowedOrigin) {
          response.status(403).json({ statusCode: 403, message: 'Request origin is not allowed.' });
          return;
        }
      }
    }
    next();
  };
}

/**
 * Sanitizes parser errors so malformed credentials are not echoed back to clients.
 * @param error Body-parser failure or an error from earlier middleware.
 * @param _request Request context, intentionally not logged.
 * @param response HTTP error response.
 * @param next Forwarder for unrelated failures.
 */
export function handleBodyError(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  const isTooLarge =
    !!error && typeof error === 'object' && 'status' in error && error.status === 413;
  if (isTooLarge || error instanceof SyntaxError) {
    const statusCode = isTooLarge ? 413 : 400;
    response.status(statusCode).json({
      statusCode,
      message: isTooLarge ? 'Request body is too large.' : 'Invalid JSON request.',
    });
    return;
  }
  next(error);
}
