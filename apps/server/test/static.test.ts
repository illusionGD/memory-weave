import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app';

describe('production web delivery', () => {
  let app: INestApplication;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memory-weave-web-'));
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><title>Memory Weave fixture</title>',
    );
    app = await createApplication({
      host: '127.0.0.1',
      port: 0,
      databaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
      adminPassword: 'test-password-for-foundation',
      appOrigin: 'http://localhost:3000',
      cookieSecure: false,
      dataDir: join(directory, 'data'),
      webDistDir: directory,
    });
  });

  afterEach(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('serves the compiled web entry for browser routes', async () => {
    const response = await request(app.getHttpServer()).get('/status').set('Accept', 'text/html');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Memory Weave fixture');
  });

  it('keeps an HTTP review deployment from upgrading its assets to HTTPS', async () => {
    const response = await request(app.getHttpServer()).get('/').set('Accept', 'text/html');
    expect(response.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it.each(['/api/missing', '/API/missing'])(
    'does not turn the API path %s into a successful SPA response',
    async (path) => {
      const response = await request(app.getHttpServer()).get(path).set('Accept', 'text/html');
      expect(response.status).toBe(404);
      expect(response.type).toBe('application/json');
    },
  );

  it('returns missing static assets as errors instead of HTML', async () => {
    const response = await request(app.getHttpServer()).get('/missing.js');
    expect(response.status).toBe(404);
    expect(response.text).not.toContain('Memory Weave fixture');
  });
});
