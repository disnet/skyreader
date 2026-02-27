import type { Env } from '../types';

interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  domain?: string;
  path?: string;
}

/**
 * Build a Set-Cookie header string
 */
export function buildSetCookieHeader(name: string, value: string, options: CookieOptions): string {
  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;

  if (options.maxAge !== undefined) {
    cookie += `; Max-Age=${options.maxAge}`;
  }
  if (options.httpOnly) {
    cookie += '; HttpOnly';
  }
  if (options.secure) {
    cookie += '; Secure';
  }
  if (options.sameSite) {
    cookie += `; SameSite=${options.sameSite}`;
  }
  if (options.domain) {
    cookie += `; Domain=${options.domain}`;
  }
  cookie += `; Path=${options.path || '/'}`;

  return cookie;
}

/**
 * Build a Set-Cookie header to clear a cookie
 */
export function buildClearCookieHeader(name: string, domain?: string): string {
  let cookie = `${encodeURIComponent(name)}=; Max-Age=0; Path=/`;
  if (domain) {
    cookie += `; Domain=${domain}`;
  }
  return cookie;
}

/**
 * Parse Cookie header into a Map
 */
export function parseCookies(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) return cookies;

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const [name, ...valueParts] = pair.trim().split('=');
    if (name) {
      const value = valueParts.join('='); // Handle values with = in them
      cookies.set(decodeURIComponent(name), decodeURIComponent(value || ''));
    }
  }
  return cookies;
}

/**
 * Get the cookie domain based on environment
 * Returns .skyreader.app for production, undefined for local dev
 */
export function getCookieDomain(env: Env, request: Request): string | undefined {
  const url = new URL(request.url);
  const host = url.hostname;

  // Local development - no domain restriction (works across ports on 127.0.0.1)
  if (host === '127.0.0.1' || host === 'localhost') {
    return undefined;
  }

  // Cloudflare tunnel - no domain restriction
  if (host.endsWith('.trycloudflare.com')) {
    return undefined;
  }

  // Production - use parent domain for cross-subdomain cookies
  if (host.endsWith('.skyreader.app') || host === 'skyreader.app') {
    return '.skyreader.app';
  }

  // Unknown domain - no restriction
  return undefined;
}

/**
 * Check if request is over HTTPS
 * Note: Do NOT treat localhost as secure - browsers won't set Secure cookies over HTTP
 */
export function isSecureContext(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === 'https:';
}

// Cookie names
export const SESSION_COOKIE_NAME = 'session_id';

// Cookie max age (30 days)
export const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
