import { resolve } from 'node:path';

/** Application settings are supplied by the deployment environment. */
export interface ServerConfig {
  /** Listener address; localhost is the development default. */
  host: string;
  /** HTTP listening port. */
  port: number;
  /** Private PostgreSQL connection string; never exposed by status endpoints. */
  databaseUrl: string;
  /** Bootstrap password; never exposed by HTTP endpoints or logs. */
  adminPassword: string;
  /** Browser origin allowed to send state-changing requests. */
  appOrigin: string;
  /** Whether cookies require an HTTPS connection. */
  cookieSecure: boolean;
  /** Persistent attachment directory. */
  dataDir: string;
  /** Optional compiled web asset directory. */
  webDistDir: string | null;
}

/** Runtime consumers do not need the plaintext bootstrap password. */
export type RuntimeConfig = Omit<ServerConfig, 'adminPassword'>;

/** Dependency injection key for validated, non-password runtime configuration. */
export const SERVER_CONFIG = Symbol('SERVER_CONFIG');

/** A configuration error names the field without exposing its secret value. */
export class ConfigurationError extends Error {}

/**
 * Reads bootstrap settings and rejects unsafe or ambiguous values before listening.
 * @param environment Environment values; secrets stay inside the process.
 * @returns Validated server settings.
 */
export function loadServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const adminPassword = environment.ADMIN_PASSWORD ?? '';
  if (adminPassword.length < 12 || adminPassword.length > 256) {
    throw new ConfigurationError('ADMIN_PASSWORD must contain 12 to 256 characters.');
  }

  const databaseUrl = environment.DATABASE_URL ?? '';
  try {
    const parsed = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error('Invalid database URL');
    }
  } catch {
    throw new ConfigurationError('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  let appOrigin: string;
  try {
    const parsed = new URL(environment.APP_ORIGIN ?? 'http://localhost:5173');
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    ) {
      throw new Error('Invalid origin');
    }
    appOrigin = parsed.origin;
  } catch {
    throw new ConfigurationError(
      'APP_ORIGIN must be an HTTP(S) origin without a path or credentials.',
    );
  }

  const port = Number(environment.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('PORT must be an integer between 1 and 65535.');
  }

  const secureSetting = environment.COOKIE_SECURE;
  if (secureSetting !== undefined && !['true', 'false'].includes(secureSetting)) {
    throw new ConfigurationError('COOKIE_SECURE must be true or false.');
  }
  const cookieSecure =
    secureSetting === undefined ? appOrigin.startsWith('https://') : secureSetting === 'true';
  if (cookieSecure && !appOrigin.startsWith('https://')) {
    throw new ConfigurationError('COOKIE_SECURE=true requires an HTTPS APP_ORIGIN.');
  }
  if (!cookieSecure && appOrigin.startsWith('https://')) {
    throw new ConfigurationError('An HTTPS APP_ORIGIN requires COOKIE_SECURE=true.');
  }

  const host = environment.HOST?.trim() || '127.0.0.1';
  const dataDir = resolve(environment.DATA_DIR ?? './data');
  const webDistDir = environment.WEB_DIST_DIR ? resolve(environment.WEB_DIST_DIR) : null;

  return { host, port, databaseUrl, adminPassword, appOrigin, cookieSecure, dataDir, webDistDir };
}
