/**
 * The two operator switches for standard.site documents, both `sync_state` rows so
 * a flip is a D1 write, not a deploy (same pattern as `timeline_enabled`).
 *
 * They are deliberately separate. `documents_ingest_enabled` stops the poller
 * *writing* — the flood response, which must not touch the subscriptions stream and
 * must leave reads serving whatever D1 already holds. `documents_v2_enabled` chooses
 * where reads *come from* — the rollout gate and the one-flip rollback to the proxy.
 * Sequencing the cutover needs both: ingest on and filling for as long as it takes,
 * reads flipped only once a shadow-compare says D1 agrees with the proxy.
 */

import type { Env } from '../types';

/** Reads served from D1 rather than the Fly proxy. Off until explicitly enabled. */
export const DOCUMENTS_V2_ENABLED_KEY = 'documents_v2_enabled';

/** The poller's document stream. On unless explicitly disabled ('0'). */
export const DOCUMENTS_INGEST_ENABLED_KEY = 'documents_ingest_enabled';

/**
 * Per-cycle apply cap override. Sized from measured burst shape; tunable without a
 * deploy because the number that matters is a property of the network, not the code.
 */
export const DOCUMENTS_APPLY_CAP_KEY = 'documents_apply_cap';

/** Applied events per poll cycle before the drain stops and carries its cursor. */
export const DEFAULT_DOCUMENT_APPLY_CAP = 500;

export interface DocumentFlags {
  /** Serve reads from D1 (opt-in: only an explicit '1'). */
  serveFromD1: boolean;
  /** Run the poller's document stream (opt-out: only an explicit '0' stops it). */
  ingestEnabled: boolean;
  applyCap: number;
}

export async function readDocumentFlags(env: Env): Promise<DocumentFlags> {
  const defaults: DocumentFlags = {
    serveFromD1: false,
    ingestEnabled: true,
    applyCap: DEFAULT_DOCUMENT_APPLY_CAP,
  };
  try {
    const result = await env.DB.prepare(`SELECT key, value FROM sync_state WHERE key IN (?, ?, ?)`)
      .bind(DOCUMENTS_V2_ENABLED_KEY, DOCUMENTS_INGEST_ENABLED_KEY, DOCUMENTS_APPLY_CAP_KEY)
      .all<{ key: string; value: string }>();
    const flags = { ...defaults };
    for (const row of result.results ?? []) {
      if (row.key === DOCUMENTS_V2_ENABLED_KEY) flags.serveFromD1 = row.value === '1';
      else if (row.key === DOCUMENTS_INGEST_ENABLED_KEY) flags.ingestEnabled = row.value !== '0';
      else if (row.key === DOCUMENTS_APPLY_CAP_KEY) {
        const cap = Number(row.value);
        if (Number.isFinite(cap) && cap > 0) flags.applyCap = Math.floor(cap);
      }
    }
    return flags;
  } catch (error) {
    // A flag read that fails must not change behaviour: keep serving from the
    // proxy and keep ingesting.
    console.error('[document-flags] read failed:', error);
    return defaults;
  }
}

export async function setDocumentFlag(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value)
    .run();
}
