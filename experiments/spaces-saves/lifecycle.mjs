/**
 * Phase 0 of the atproto Spaces saves spike: the full protocol lifecycle against
 * a real spaces-capable PDS, with every request/response summarised as it goes.
 *
 * It deliberately imports the backend's own spaces modules rather than the alpha
 * `@atproto/*` SDK. Two reasons: the backend runs on Workers and can't take the
 * SDK, so the wire code has to be hand-rolled anyway; and a Phase 0 that
 * exercises different code from Phases 1-3 proves nothing about them. Node runs
 * the .ts sources directly via type stripping (Node >= 22.18 / 24).
 *
 * Usage:
 *
 *   SPACES_PDS_URL=http://localhost:2583 \
 *   SPACES_INVITE_CODE=...        # if the PDS requires one
 *   node experiments/spaces-saves/lifecycle.mjs
 *
 * It creates two throwaway accounts (an owner and an outsider), so point it only
 * at a sandbox: the alpha hosted PDS (BPS invite) or a local
 * `ghcr.io/bluesky-social/atproto:pds-spaces-alpha`.
 *
 * Exit code 0 means every check passed, including the two that matter most:
 * the outsider is denied, and a second, independent client reads the record back
 * with its own credential.
 */

import {
  SpacesClient,
  PERSONAL_SPACE_POLICY,
  PERSONAL_SPACE_APP_ACCESS,
} from '../../backend/src/services/spaces/client.ts';
import {
  bearerCall,
  credentialCall,
  isSpaceAccessDenied,
  isSpaceNotFound,
} from '../../backend/src/services/spaces/transport.ts';
import { mintSpaceCredential } from '../../backend/src/services/spaces/credential.ts';
import { savedRowToSpaceRecord } from '../../backend/src/services/spaces/record.ts';
import {
  SAVED_COLLECTION,
  SAVED_SPACE_SKEY,
  SAVED_SPACE_TYPE,
  savedSpaceRef,
} from '../../backend/src/services/spaces/refs.ts';

// `--fake` swaps in an in-process stand-in (fake-pds.mjs) so the harness itself
// can be exercised without a spaces PDS. A green --fake run proves the script and
// the client code work; it proves nothing about the real implementation. Read the
// header of fake-pds.mjs before quoting a --fake result as a finding.
const FAKE = process.argv.includes('--fake') || process.env.SPACES_FAKE === '1';
if (FAKE) {
  const { createFakePds } = await import('./fake-pds.mjs');
  const fake = createFakePds();
  process.env.SPACES_PDS_URL = fake.origin;
  globalThis.fetch = fake.fetch;
}

const PDS_URL = (process.env.SPACES_PDS_URL ?? 'http://localhost:2583').replace(/\/$/, '');
const INVITE_CODE = process.env.SPACES_INVITE_CODE;
const SUFFIX = Math.random().toString(36).slice(2, 8);

const results = [];
let failed = 0;

function step(name) {
  const startedAt = Date.now();
  return {
    ok(detail) {
      const ms = Date.now() - startedAt;
      results.push({ name, status: 'ok', ms, detail });
      console.log(`  ✓ ${name} (${ms}ms)${detail ? ` — ${detail}` : ''}`);
    },
    fail(error) {
      const ms = Date.now() - startedAt;
      failed++;
      const detail = error?.code
        ? `${error.code}: ${error.message}`
        : String(error?.message ?? error);
      results.push({ name, status: 'FAILED', ms, detail });
      console.error(`  ✗ ${name} (${ms}ms) — ${detail}`);
    },
  };
}

async function xrpc(method, endpoint, body, headers = {}) {
  const url = `${PDS_URL}/xrpc/${endpoint}`;
  const response = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const error = new Error(parsed?.message ?? `HTTP ${response.status}`);
    error.code = parsed?.error ?? `HTTP${response.status}`;
    throw error;
  }
  return parsed;
}

async function createAccount(label) {
  const handle = `${label}-${SUFFIX}.test`;
  const password = `pw-${SUFFIX}`;
  try {
    await xrpc('POST', 'com.atproto.server.createAccount', {
      handle,
      email: `${label}-${SUFFIX}@example.invalid`,
      password,
      ...(INVITE_CODE ? { inviteCode: INVITE_CODE } : {}),
    });
  } catch (error) {
    if (error.code !== 'HandleNotAvailable') throw error;
  }
  const session = await xrpc('POST', 'com.atproto.server.createSession', {
    identifier: handle,
    password,
  });
  console.log(`  · ${label}: ${session.did} (${handle})`);
  return { did: session.did, accessJwt: session.accessJwt, handle };
}

/** A saved_articles row shaped like the one the backend mirrors. */
function sampleRow(rkey) {
  return {
    rkey,
    url: 'https://example.com/spaces-spike',
    title: 'Saved through a space',
    author: 'Skyreader spike',
    description: 'Metadata only — the body stays in D1.',
    content_type: 'webpage',
    domain: 'example.com',
    image: null,
    word_count: 987,
    published_at: Date.UTC(2026, 7, 20),
    saved_at: Date.now(),
    source: 'url',
    item_guid: null,
  };
}

async function main() {
  console.log(`atproto Spaces lifecycle against ${PDS_URL}\n`);

  console.log('accounts');
  const owner = await createAccount('owner');
  const outsider = await createAccount('outsider');

  const ownerClient = new SpacesClient(bearerCall(PDS_URL, owner.accessJwt));
  const outsiderClient = new SpacesClient(bearerCall(PDS_URL, outsider.accessJwt));
  const space = savedSpaceRef(owner.did);
  const rkey = `3lspike${SUFFIX}`;

  console.log('\nspace lifecycle');

  let s = step('createSpace (member-list policy, open app access)');
  try {
    const created = await ownerClient.createSpace({
      type: SAVED_SPACE_TYPE,
      skey: SAVED_SPACE_SKEY,
      policy: PERSONAL_SPACE_POLICY,
      appAccess: PERSONAL_SPACE_APP_ACCESS,
    });
    s.ok(created.uri);
    if (created.uri !== space) {
      console.warn(`    ! space uri differs from the derived ref: ${created.uri} vs ${space}`);
    }
  } catch (error) {
    if (error.code === 'SpaceAlreadyExists') s.ok('already existed');
    else s.fail(error);
  }

  s = step('getSpace');
  try {
    const view = await ownerClient.getSpace(space);
    s.ok(`${view.policy?.$type} / ${view.appAccess?.$type}`);
  } catch (error) {
    s.fail(error);
  }

  const record = savedRowToSpaceRecord(sampleRow(rkey));

  s = step('createRecord (session auth, own repo)');
  try {
    const created = await ownerClient.createRecord({
      space,
      repo: owner.did,
      collection: SAVED_COLLECTION,
      rkey,
      record,
    });
    s.ok(`${created.uri} (validation: ${created.validationStatus ?? 'n/a'})`);
  } catch (error) {
    s.fail(error);
  }

  s = step('getRecord round-trips every field');
  try {
    const fetched = await ownerClient.getRecord({
      space,
      repo: owner.did,
      collection: SAVED_COLLECTION,
      rkey,
    });
    const drift = Object.keys(record).filter((k) => fetched.value?.[k] !== record[k]);
    if (drift.length) throw Object.assign(new Error(`fields changed: ${drift.join(', ')}`), {});
    s.ok(`${Object.keys(record).length} fields intact`);
  } catch (error) {
    s.fail(error);
  }

  s = step('listRecords sees the record');
  try {
    const listed = await ownerClient.listAllRecords({
      space,
      repo: owner.did,
      collection: SAVED_COLLECTION,
    });
    if (!listed.some((r) => r.rkey === rkey)) throw new Error('record missing from listing');
    s.ok(`${listed.length} record(s)`);
  } catch (error) {
    s.fail(error);
  }

  console.log('\nprivacy');

  s = step('outsider is DENIED a read of the space');
  try {
    await outsiderClient.listRecords({ space, repo: owner.did, collection: SAVED_COLLECTION });
    s.fail(new Error('outsider read SUCCEEDED — the privacy claim fails'));
  } catch (error) {
    if (isSpaceAccessDenied(error) || error.status === 401 || error.status === 403) {
      s.ok(error.code);
    } else {
      s.fail(error);
    }
  }

  s = step('outsider cannot mint a credential for the space');
  try {
    await mintSpaceCredential({
      space,
      authorityPdsUrl: PDS_URL,
      getDelegationToken: async (target) => (await outsiderClient.getDelegationToken(target)).token,
    });
    s.fail(new Error('outsider minted a credential — the privacy claim fails'));
  } catch (error) {
    if (isSpaceAccessDenied(error)) s.ok(error.code);
    else s.fail(error);
  }

  console.log('\nportability (the point of the spike)');

  s = step('owner mints a space credential (delegation -> credential -> DPoP)');
  let credential;
  try {
    const startedAt = Date.now();
    credential = await mintSpaceCredential({
      space,
      authorityPdsUrl: PDS_URL,
      getDelegationToken: async (target) => (await ownerClient.getDelegationToken(target)).token,
    });
    const ttlSec = Math.round((credential.expiresAt - Date.now()) / 1000);
    s.ok(`two round trips in ${Date.now() - startedAt}ms, credential TTL ~${ttlSec}s`);
  } catch (error) {
    s.fail(error);
  }

  s = step('an independent client reads the save with only that credential');
  try {
    if (!credential) throw new Error('no credential');
    // Nothing of the owner's session is in play here — just the credential and
    // the key it is bound to. This is the portability claim, executed.
    const independent = new SpacesClient(credentialCall(PDS_URL, credential));
    const fetched = await independent.getRecord({
      space,
      repo: owner.did,
      collection: SAVED_COLLECTION,
      rkey,
    });
    if (fetched.value?.url !== record.url) throw new Error('record did not match');
    s.ok(`read "${fetched.value?.title}" out of the space`);
  } catch (error) {
    s.fail(error);
  }

  console.log('\nteardown');

  s = step('deleteRecord');
  try {
    await ownerClient.deleteRecord({ space, repo: owner.did, collection: SAVED_COLLECTION, rkey });
    s.ok();
  } catch (error) {
    s.fail(error);
  }

  s = step('the deleted record is gone');
  try {
    await ownerClient.getRecord({ space, repo: owner.did, collection: SAVED_COLLECTION, rkey });
    s.fail(new Error('record still readable after delete'));
  } catch (error) {
    if (error.code === 'RecordNotFound' || isSpaceNotFound(error)) s.ok(error.code);
    else s.fail(error);
  }

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  console.log('\nPaste this into FINDINGS.md:\n');
  console.log(JSON.stringify({ pds: PDS_URL, results }, null, 2));

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nlifecycle aborted:', error);
  process.exit(2);
});
