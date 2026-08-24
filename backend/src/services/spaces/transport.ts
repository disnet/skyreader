/**
 * `XrpcCall` transports for `SpacesClient`.
 *
 * Two auth modes, both real and both used:
 *
 *   sessionCall     — ordinary OAuth session auth against the user's own PDS.
 *                     Enough to create a personal space and to write records into
 *                     your own repo inside it (the reference app does exactly
 *                     this), so the D1 mirror needs nothing more.
 *   credentialCall  — a DPoP-bound space credential, presented to any host serving
 *                     the space. What a *second* client needs to read the space —
 *                     i.e. the portability claim.
 *
 * Kept free of Workers/Env imports so `experiments/spaces-saves/` can run the
 * identical code on Node against a live spaces PDS.
 */

import type { SpaceCredential } from './credential';
import type { XrpcCall } from './client';

export class SpaceXrpcError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = 'SpaceXrpcError';
    this.code = code;
    this.status = status;
  }
}

/** Minimal shape of `PDSClient` — structural, so this module stays dependency-free. */
export interface SessionXrpcClient {
  xrpc<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: unknown
  ): Promise<
    | { success: true; data: T }
    | { success: false; error: string; code?: string; status?: number; retryable: boolean }
  >;
}

/** Session auth (OAuth access token + the session's own DPoP key). */
export function sessionCall(client: SessionXrpcClient): XrpcCall {
  return async <T>(method: 'GET' | 'POST', endpoint: string, body?: unknown): Promise<T> => {
    const result = await client.xrpc<T>(method, endpoint, body);
    if (!result.success) {
      throw new SpaceXrpcError(
        result.error,
        result.code ?? `HTTP${result.status ?? 0}`,
        result.status
      );
    }
    return result.data;
  };
}

/**
 * Space-credential auth against one host. The credential is re-authorized per
 * request because the DPoP proof binds method + URL (and carries a fresh `jti`),
 * so it cannot be built once and reused.
 */
export function credentialCall(
  host: string,
  credential: SpaceCredential,
  fetchImpl: typeof fetch = fetch
): XrpcCall {
  return httpCall(host, (method, url) => credential.authorize(method, url), fetchImpl);
}

/**
 * Legacy `com.atproto.server.createSession` auth (Bearer access JWT).
 *
 * Not used by the backend — production sessions are OAuth/DPoP. It exists for
 * the standalone Node experiment, which drives a throwaway account on an alpha
 * PDS and has no reason to stand up an OAuth client to do it.
 */
export function bearerCall(
  host: string,
  accessJwt: string,
  fetchImpl: typeof fetch = fetch
): XrpcCall {
  return httpCall(host, async () => ({ Authorization: `Bearer ${accessJwt}` }), fetchImpl);
}

function httpCall(
  host: string,
  authorize: (method: string, url: string) => Promise<Record<string, string>>,
  fetchImpl: typeof fetch
): XrpcCall {
  const base = host.replace(/\/$/, '');
  return async <T>(method: 'GET' | 'POST', endpoint: string, body?: unknown): Promise<T> => {
    const url = `${base}/xrpc/${endpoint}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(await authorize(method, url)),
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      const err = (parsed ?? {}) as { error?: unknown; message?: unknown };
      const code = typeof err.error === 'string' ? err.error : `HTTP${response.status}`;
      const message = typeof err.message === 'string' ? err.message : code;
      throw new SpaceXrpcError(message, code, response.status);
    }
    return parsed as T;
  };
}

/** True when the error means "this space does not exist (here)". */
export function isSpaceNotFound(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'SpaceNotFound' || code === 'SpaceDeleted';
}

/** True when the error means "you are not allowed into this space". */
export function isSpaceAccessDenied(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === 'UserNotAuthorized' ||
    code === 'AppNotAuthorized' ||
    code === 'NotAuthorized' ||
    code === 'RepoNotFound'
  );
}

/**
 * True when the host doesn't implement Spaces at all — every real PDS today.
 * The probe has to be cheap and silent for those, so this is checked first.
 */
export function isSpacesUnsupported(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 'MethodNotImplemented' || code === 'InvalidRequest') return true;
  const status = (error as { status?: unknown })?.status;
  return status === 404 || status === 501;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
}
