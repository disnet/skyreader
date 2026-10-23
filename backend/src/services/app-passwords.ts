import type { Env } from '../types';
import { sha256Hex } from '../utils/sha256';

/**
 * App passwords: one credential per third-party RSS app, for the Google Reader
 * API (routes/greader.ts). Those clients sign in with a username and password
 * and can't do atproto OAuth, so a reader makes one here and revokes it here.
 *
 * A password is 20 base32 characters (100 random bits), shown once as
 * `xxxx-xxxx-xxxx-xxxx-xxxx`. Only its SHA-256 is stored. Matching ignores case
 * and anything that isn't a letter or digit, so a password retyped on a phone
 * (capitalised, dashes dropped) still works.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const PASSWORD_CHARS = 20;

// A reader has a handful of apps at most; the cap keeps a script from filling
// the table.
export const MAX_APP_PASSWORDS = 20;
export const MAX_APP_PASSWORD_NAME = 60;

// last_used_at is for the Settings list ("used 3 days ago"), not an audit log:
// stamped at most once an hour so a syncing client doesn't write on every call.
const LAST_USED_RESOLUTION_SECONDS = 3600;

export interface AppPasswordOwner {
  id: number;
  did: string;
  handle: string;
}

export interface AppPasswordListing {
  id: number;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Lowercase letters and digits only: the form a password is hashed in. */
export function canonicalAppPassword(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function generatePassword(): string {
  // 256 is a multiple of 32, so `byte & 31` is unbiased.
  const bytes = crypto.getRandomValues(new Uint8Array(PASSWORD_CHARS));
  const chars = [...bytes].map((b) => ALPHABET[b & 31]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

async function hashPassword(password: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalAppPassword(password)));
}

export async function listAppPasswords(env: Env, did: string): Promise<AppPasswordListing[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, created_at, last_used_at FROM app_passwords
      WHERE user_did = ? ORDER BY created_at DESC, id DESC`
  )
    .bind(did)
    .all<{ id: number; name: string; created_at: number; last_used_at: number | null }>();
  return rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/**
 * Make a password. Returns it in the clear exactly once; null when the reader
 * already has the maximum.
 */
export async function createAppPassword(
  env: Env,
  did: string,
  name: string
): Promise<{ id: number; password: string } | null> {
  const password = generatePassword();
  // The count and the insert are one statement, so two concurrent creates
  // can't both slip under the cap.
  const row = await env.DB.prepare(
    `INSERT INTO app_passwords (user_did, name, token_hash)
     SELECT ?1, ?2, ?3
      WHERE (SELECT COUNT(*) FROM app_passwords WHERE user_did = ?1) < ?4
     RETURNING id`
  )
    .bind(did, name, await hashPassword(password), MAX_APP_PASSWORDS)
    .first<{ id: number }>();
  return row ? { id: row.id, password } : null;
}

/** Revoke one of the reader's passwords. False when it wasn't theirs or is already gone. */
export async function revokeAppPassword(env: Env, did: string, id: number): Promise<boolean> {
  const result = await env.DB.prepare('DELETE FROM app_passwords WHERE id = ? AND user_did = ?')
    .bind(id, did)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** The reader an app password belongs to, or null when it matches none. */
export async function verifyAppPassword(
  env: Env,
  password: string
): Promise<AppPasswordOwner | null> {
  if (canonicalAppPassword(password).length !== PASSWORD_CHARS) return null;
  const row = await env.DB.prepare(
    `SELECT ap.id, ap.user_did, u.handle
       FROM app_passwords ap
       JOIN users u ON u.did = ap.user_did
      WHERE ap.token_hash = ?`
  )
    .bind(await hashPassword(password))
    .first<{ id: number; user_did: string; handle: string }>();
  return row ? { id: row.id, did: row.user_did, handle: row.handle } : null;
}

export async function touchAppPassword(env: Env, id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE app_passwords SET last_used_at = unixepoch()
      WHERE id = ? AND (last_used_at IS NULL OR last_used_at < unixepoch() - ?)`
  )
    .bind(id, LAST_USED_RESOLUTION_SECONDS)
    .run();
}
