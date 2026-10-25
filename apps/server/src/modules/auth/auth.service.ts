import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';

const deriveKey = promisify(scrypt);

/** Cookie sessions expire after twelve hours and do not survive process restarts. */
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

const MAX_SESSIONS = 10;
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_LOGIN_SOURCES = 1024;

/** Single-owner bootstrap authentication; persistent user identities arrive in F02. */
@Injectable()
export class AuthService implements OnModuleDestroy {
  private readonly sessions = new Map<string, number>();
  private readonly loginAttempts = new Map<string, { count: number; expiresAt: number }>();

  private constructor(
    private readonly salt: Buffer,
    private readonly passwordHash: Buffer,
  ) {}

  /**
   * Prepares the password verifier without retaining the plaintext input.
   * @param password Deployment bootstrap password.
   * @returns A service ready to verify logins.
   */
  static async create(password: string): Promise<AuthService> {
    const salt = randomBytes(32);
    const hash = (await deriveKey(password, salt, 64)) as Buffer;
    return new AuthService(salt, hash);
  }

  /**
   * Compares a password using a derived key and a constant-time equality check.
   * @param password Password received through the validated login request.
   * @returns Whether the supplied password matches.
   */
  async verifyPassword(password: string): Promise<boolean> {
    const candidate = (await deriveKey(password, this.salt, 64)) as Buffer;
    const valid = timingSafeEqual(candidate, this.passwordHash);
    candidate.fill(0);
    return valid;
  }

  /**
   * Applies a bounded per-source login window before expensive password hashing.
   * @param source Socket-derived client identity; forwarded headers are not trusted.
   */
  checkLoginRate(source: string): void {
    const now = Date.now();
    for (const [key, entry] of this.loginAttempts) {
      if (entry.expiresAt <= now) this.loginAttempts.delete(key);
    }
    const entry = this.loginAttempts.get(source);
    if (entry) {
      if (entry.count >= MAX_LOGIN_ATTEMPTS) {
        throw new HttpException(
          'Too many login attempts. Try again in one minute.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      entry.count += 1;
      return;
    }
    if (this.loginAttempts.size >= MAX_LOGIN_SOURCES) {
      throw new HttpException('Login is temporarily busy.', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.loginAttempts.set(source, { count: 1, expiresAt: now + LOGIN_WINDOW_MS });
  }

  /**
   * Allocates an opaque session while keeping only its digest server-side.
   * @returns Token to deliver exclusively in an HttpOnly cookie.
   */
  createSession(): string {
    this.removeExpiredSessions();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest) this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('hex');
    this.sessions.set(this.digest(token), Date.now() + SESSION_LIFETIME_MS);
    return token;
  }

  /**
   * Checks expiry and server ownership rather than trusting client-side state.
   * @param token Untrusted cookie value.
   * @returns Whether the token identifies an active session.
   */
  hasSession(token: string | null): boolean {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const digest = this.digest(token);
    const expiresAt = this.sessions.get(digest);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.sessions.delete(digest);
      return false;
    }
    return true;
  }

  /**
   * Revokes a session so replaying the old cookie cannot authenticate again.
   * @param token Session cookie value, if present.
   */
  revokeSession(token: string | null): void {
    if (token) this.sessions.delete(this.digest(token));
  }

  /** Clears process-local credentials and sessions on shutdown. */
  onModuleDestroy(): void {
    this.passwordHash.fill(0);
    this.sessions.clear();
    this.loginAttempts.clear();
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private removeExpiredSessions(): void {
    const now = Date.now();
    for (const [digest, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(digest);
    }
  }
}
