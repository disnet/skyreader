import type { Env } from '../types';

interface ExecBody {
  statements?: string[];
}

/**
 * Test-only endpoint that runs SQL against the worker's own D1 binding.
 *
 * E2E setup/teardown used to shell out to `wrangler d1 execute --local`, a separate
 * process opening the same local SQLite file the dev server already holds — which
 * intermittently failed with SQLITE_BUSY ("database is locked"). Routing seed/cleanup
 * SQL through the running worker means a single process owns the database, so there's
 * no cross-process lock contention.
 *
 * This handler is ONLY mounted when `E2E_TEST_MODE === 'true'` (set in `.dev.vars`
 * for local/CI e2e runs and never in production), so the arbitrary-SQL capability is
 * unreachable outside tests.
 */
export async function handleTestExec(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: ExecBody;
  try {
    body = (await request.json()) as ExecBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const statements = body.statements;
  if (!Array.isArray(statements) || statements.some((s) => typeof s !== 'string')) {
    return new Response(JSON.stringify({ error: 'statements must be an array of strings' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Run as one batch so multi-statement seeds/cleanups apply atomically.
  if (statements.length > 0) {
    await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
