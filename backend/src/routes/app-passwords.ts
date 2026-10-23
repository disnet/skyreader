import type { Env, Session } from '../types';
import {
  createAppPassword,
  listAppPasswords,
  revokeAppPassword,
  MAX_APP_PASSWORDS,
  MAX_APP_PASSWORD_NAME,
} from '../services/app-passwords';
import { GREADER_PATH } from './greader';

/**
 * App passwords for other RSS apps, managed from Settings (services/app-passwords.ts).
 *
 *   GET    /api/app-passwords      → { passwords, serverUrl, username }
 *   POST   /api/app-passwords      { name } → { id, name, password }  (the only time it's shown)
 *   DELETE /api/app-passwords/:id  → { success: true }
 *
 * `serverUrl` and `username` are what the reader types into their app, so the
 * page shows this environment's own address rather than hardcoding production.
 */

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function handleAppPasswords(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  const url = new URL(request.url);
  const idPart = url.pathname.slice('/api/app-passwords'.length).replace(/^\//, '');

  if (idPart) {
    if (request.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405);
    const id = Number(idPart);
    if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'Not found' }, 404);
    const revoked = await revokeAppPassword(env, session.did, id);
    return revoked ? json({ success: true }) : json({ error: 'Not found' }, 404);
  }

  if (request.method === 'GET') {
    return json({
      passwords: await listAppPasswords(env, session.did),
      serverUrl: `${url.origin}${GREADER_PATH}`,
      username: session.handle,
    });
  }

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: { name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > MAX_APP_PASSWORD_NAME) {
    return json(
      { error: `Give the password a name of up to ${MAX_APP_PASSWORD_NAME} characters` },
      400
    );
  }

  const created = await createAppPassword(env, session.did, name);
  if (!created) {
    return json(
      { error: `You can have up to ${MAX_APP_PASSWORDS} app passwords. Revoke one first.` },
      409
    );
  }
  return json({ id: created.id, name, password: created.password }, 201);
}
