import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { INestApplication } from '@nestjs/common';
import { ConfigurationError } from './config.js';

/**
 * Serves compiled browser assets without converting unknown API routes to HTML.
 * @param app Initialized HTTP adapter awaiting route registration.
 * @param directory Absolute build output directory.
 */
export async function attachWebAssets(app: INestApplication, directory: string): Promise<void> {
  const entry = join(directory, 'index.html');
  try {
    if (!(await stat(entry)).isFile()) throw new Error('Missing entry');
  } catch {
    throw new ConfigurationError('WEB_DIST_DIR must contain a compiled index.html.');
  }
  const serveStatic = express.static(directory, { index: false, dotfiles: 'deny' });
  app.use((request: Request, response: Response, next: NextFunction): void => {
    const path = request.path.toLowerCase();
    if (path === '/api' || path.startsWith('/api/')) {
      next();
      return;
    }
    serveStatic(request, response, next);
  });
  app.use((request: Request, response: Response, next: NextFunction): void => {
    const path = request.path.toLowerCase();
    if (
      request.method !== 'GET' ||
      path === '/api' ||
      path.startsWith('/api/') ||
      extname(path) !== '' ||
      !request.accepts('html')
    ) {
      next();
      return;
    }
    response.sendFile(entry);
  });
}
