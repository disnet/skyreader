import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

let userSeq = 0;

async function createUser(): Promise<string> {
  userSeq++;
  const did = `did:plc:order${userSeq}x${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `order-session-${did}`;
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())`
  )
    .bind(did, `${did}.test`, 'https://test.pds.example')
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      sessionId,
      did,
      `${did}.test`,
      'https://test.pds.example',
      'test-access-token',
      'test-refresh-token',
      JSON.stringify({ kty: 'EC' }),
      Date.now() + 3600000
    )
    .run();
  return sessionId;
}

async function call(session: string, path: string, method = 'GET', body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`http://localhost${path}`, {
      method,
      headers: {
        Cookie: `session_id=${session}`,
        Origin: 'https://skyreader.app',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function channel(uuid: string, name: string, position: number, updatedAt: number) {
  return { uuid, name, config: '{}', position, createdAt: 1000, updatedAt };
}

async function list(session: string) {
  const body = (await (await call(session, '/api/channels')).json()) as {
    channels: Array<{ uuid: string; name: string; position: number; updatedAt: number }>;
  };
  return body.channels;
}

describe('PUT /api/channels/order', () => {
  it('moves channels without touching their name or config', async () => {
    const session = await createUser();
    await call(session, '/api/channels', 'PUT', {
      channels: [channel(A, 'Alpha', 0, 1000), channel(B, 'Beta', 1, 1000)],
    });
    // Another device renames Beta after this one last synced.
    await call(session, `/api/channels/${B}`, 'PUT', channel(B, 'Renamed', 1, 3000));

    const res = await call(session, '/api/channels/order', 'PUT', {
      channels: [
        { uuid: B, position: 0 },
        { uuid: A, position: 1 },
      ],
      updatedAt: 2000,
    });
    expect(res.status).toBe(200);

    const channels = await list(session);
    expect(channels.map((c) => [c.name, c.position])).toEqual([
      ['Renamed', 0],
      ['Alpha', 1],
    ]);
    // The newer edit keeps its stamp; the moved row takes the reorder's.
    expect(channels.map((c) => c.updatedAt)).toEqual([3000, 2000]);
  });

  it("an edit from a device with a stale order doesn't move the channel back", async () => {
    const session = await createUser();
    await call(session, '/api/channels', 'PUT', {
      channels: [channel(A, 'Alpha', 0, 1000), channel(B, 'Beta', 1, 1000)],
    });
    await call(session, '/api/channels/order', 'PUT', {
      channels: [
        { uuid: B, position: 0 },
        { uuid: A, position: 1 },
      ],
      updatedAt: 2000,
    });
    await call(session, `/api/channels/${A}`, 'PUT', channel(A, 'Alpha 2', 0, 3000));

    const channels = await list(session);
    expect(channels.map((c) => [c.name, c.position])).toEqual([
      ['Beta', 0],
      ['Alpha 2', 1],
    ]);
  });

  it('rejects a bad body', async () => {
    const session = await createUser();
    const bad = await call(session, '/api/channels/order', 'PUT', {
      channels: [{ uuid: 'nope', position: 0 }],
      updatedAt: 1,
    });
    expect(bad.status).toBe(400);
    const noStamp = await call(session, '/api/channels/order', 'PUT', { channels: [] });
    expect(noStamp.status).toBe(400);
  });
});
