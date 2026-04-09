import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 200;
const MAX_CONFIG_LENGTH = 50_000; // 50 KB serialized config limit

interface ChannelRow {
  uuid: string;
  name: string;
  config: string;
  position: number;
  created_at: number;
  updated_at: number;
}

interface ChannelBody {
  name: string;
  config: string;
  position: number;
  createdAt: number;
  updatedAt: number;
}

interface SyncChannelsBody {
  channels: Array<{
    uuid: string;
    name: string;
    config: string;
    position: number;
    createdAt: number;
    updatedAt: number;
  }>;
}

function validateUuid(uuid: string): string | null {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return 'Invalid UUID format';
  return null;
}

function validateChannelBody(body: ChannelBody, uuid?: string): string | null {
  if (uuid != null) {
    const uuidErr = validateUuid(uuid);
    if (uuidErr) return uuidErr;
  }
  if (typeof body.name !== 'string' || body.name.length === 0) return 'Name is required';
  if (body.name.length > MAX_NAME_LENGTH)
    return `Name must be ${MAX_NAME_LENGTH} characters or less`;
  if (typeof body.config !== 'string') return 'Config must be a string';
  if (body.config.length > MAX_CONFIG_LENGTH) return 'Config is too large';
  try {
    JSON.parse(body.config);
  } catch {
    return 'Config must be valid JSON';
  }
  if (typeof body.position !== 'number' || !Number.isFinite(body.position) || body.position < 0)
    return 'Position must be a non-negative number';
  if (typeof body.createdAt !== 'number' || !Number.isFinite(body.createdAt))
    return 'createdAt must be a number';
  if (typeof body.updatedAt !== 'number' || !Number.isFinite(body.updatedAt))
    return 'updatedAt must be a number';
  return null;
}

function validationError(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

// GET /api/channels - Get all channels for the current user
export async function handleGetChannels(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await env.DB.prepare(
      `SELECT uuid, name, config, position, created_at, updated_at
       FROM channels WHERE user_did = ? AND deleted_at IS NULL ORDER BY position`
    )
      .bind(session.did)
      .all<ChannelRow>();

    const channels = result.results.map((row) => ({
      uuid: row.uuid,
      name: row.name,
      config: row.config,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    // Also return UUIDs of recently deleted channels so other devices can remove them
    const deletedResult = await env.DB.prepare(
      `SELECT uuid FROM channels WHERE user_did = ? AND deleted_at IS NOT NULL`
    )
      .bind(session.did)
      .all<{ uuid: string }>();

    const deletedUuids = deletedResult.results.map((row) => row.uuid);

    return new Response(JSON.stringify({ channels, deletedUuids }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to get channels:', error);
    return new Response(JSON.stringify({ error: 'Failed to get channels' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// PUT /api/channels - Sync all channels (bulk upsert)
export async function handleSyncChannels(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: SyncChannelsBody;
  try {
    body = (await request.json()) as SyncChannelsBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!Array.isArray(body.channels)) {
    return validationError('Missing channels array');
  }

  for (const channel of body.channels) {
    const err = validateChannelBody(channel, channel.uuid);
    if (err) return validationError(err);
  }

  try {
    const statements = body.channels.map((channel) =>
      env.DB.prepare(
        `INSERT INTO channels (uuid, user_did, name, config, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_did, uuid) DO UPDATE SET
           name = excluded.name,
           config = excluded.config,
           position = excluded.position,
           updated_at = excluded.updated_at
         WHERE deleted_at IS NULL`
      ).bind(
        channel.uuid,
        session.did,
        channel.name,
        channel.config,
        channel.position,
        channel.createdAt,
        channel.updatedAt
      )
    );

    if (statements.length > 0) {
      await env.DB.batch(statements);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to sync channels:', error);
    return new Response(JSON.stringify({ error: 'Failed to sync channels' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// PUT /api/channels/:uuid - Upsert a single channel
export async function handleUpsertChannel(
  request: Request,
  env: Env,
  uuid: string
): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const uuidErr = validateUuid(uuid);
  if (uuidErr) return validationError(uuidErr);

  let body: ChannelBody;
  try {
    body = (await request.json()) as ChannelBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const bodyErr = validateChannelBody(body);
  if (bodyErr) return validationError(bodyErr);

  try {
    await env.DB.prepare(
      `INSERT INTO channels (uuid, user_did, name, config, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_did, uuid) DO UPDATE SET
         name = excluded.name,
         config = excluded.config,
         position = excluded.position,
         updated_at = excluded.updated_at
       WHERE deleted_at IS NULL`
    )
      .bind(
        uuid,
        session.did,
        body.name,
        body.config,
        body.position,
        body.createdAt,
        body.updatedAt
      )
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to upsert channel:', error);
    return new Response(JSON.stringify({ error: 'Failed to upsert channel' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// DELETE /api/channels/:uuid - Soft delete a channel
export async function handleDeleteChannel(
  request: Request,
  env: Env,
  uuid: string
): Promise<Response> {
  const uuidErr = validateUuid(uuid);
  if (uuidErr) return validationError(uuidErr);

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const now = Date.now();
    // Atomic soft-delete: upsert a tombstone whether the row exists or not.
    await env.DB.prepare(
      `INSERT INTO channels (uuid, user_did, name, config, position, created_at, updated_at, deleted_at)
       VALUES (?, ?, '', '{}', 0, ?, ?, ?)
       ON CONFLICT (user_did, uuid) DO UPDATE SET deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`
    )
      .bind(uuid, session.did, now, now, now)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to delete channel:', error);
    return new Response(JSON.stringify({ error: 'Failed to delete channel' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
