/**
 * Spike 1 of the follow-ups: a true second client.
 *
 * Plays an app that is NOT Skyreader reading a reader's saved-space. It knows
 * only what any app could know: the reader's DID and (for this test account
 * only) their password. Everything else comes from the network:
 *
 *   - the PDS and the `#atproto_kem` key, out of the DID doc via PLC — not via
 *     the owner's session, the way the lifecycle's shortcut gets it;
 *   - a session of its own at that PDS (no Skyreader cookie, no OAuth client_id);
 *   - a space credential with NO client attestation, so it is an unknown app.
 *
 * Then it reports what that app could do:
 *
 *   session read     listRecords on the reader's own repo through its own session.
 *                    Only OAuth scopes gate this, and a password session has
 *                    them all.
 *   credential       getSpaceCredential without an attestation. A personalspace
 *                    has no app allow-list, so any app acting for the owner gets
 *                    one.
 *   credential read  listRecords + a getRecord whose uri, MAC and value-to-CID
 *                    check out — the "portable" half of the claim.
 *
 * Usage, against the account Skyreader is mirroring into (a throwaway test
 * account: it needs the account password, because app passwords can't mint
 * delegation tokens):
 *
 *   SPACES_OWNER_DID=did:plc:… SPACES_PASSWORD=… npm run second-client
 *
 * Add `-- --to-personalspace` once to convert a space made before the switch to
 * personalspace (Oct 29 migration, or the removed allow-list toggle).
 *
 * The config read (getSpace) works because this app signs in as the owner:
 * since the Oct 29 alpha getSpace is owner-only, and no credential reaches it.
 *
 * `PLC_URL` overrides https://plc.directory. `--fake` runs against the
 * in-process fake, seeding an account and a save first.
 */

import { PERSONAL_SPACE_POLICY, SpacesClient } from '../../backend/src/services/spaces/client.ts';
import { bearerCall, credentialCall } from '../../backend/src/services/spaces/transport.ts';
import { mintSpaceCredential } from '../../backend/src/services/spaces/credential.ts';
import { SAVED_COLLECTION, savedSpaceRef } from '../../backend/src/services/spaces/refs.ts';

const FAKE = process.argv.includes('--fake');
const TO_PERSONALSPACE = process.argv.includes('--to-personalspace');

/** The DID doc, from PLC for did:plc and from the domain for did:web. */
async function resolveDidDoc(did, plcUrl) {
  const url = did.startsWith('did:plc:')
    ? `${plcUrl.replace(/\/$/, '')}/${did}`
    : did.startsWith('did:web:')
      ? `https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`
      : null;
  if (!url) throw new Error(`unsupported DID method: ${did}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`DID doc fetch failed: HTTP ${response.status}`);
  const doc = await response.json();
  const pds = doc.service?.find(
    (s) => s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`
  )?.serviceEndpoint;
  const kem = doc.verificationMethod?.find((v) => v.id.endsWith('#atproto_kem'));
  return {
    pds: typeof pds === 'string' ? pds.replace(/\/$/, '') : undefined,
    kemKey: kem?.publicKeyMultibase ? `did:key:${kem.publicKeyMultibase}` : undefined,
  };
}

/** Run the outside app's checks. Returns `{ results, credentialIssued }`. */
export async function runSecondClient({
  did,
  password,
  plcUrl,
  toPersonalspace = false,
  log = console.log,
}) {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const describe = (error) => (error?.code ? `${error.code}: ${error.message}` : String(error));

  const { pds, kemKey } = await resolveDidDoc(did, plcUrl);
  record('DID doc names a PDS', !!pds, pds);
  record('DID doc publishes #atproto_kem', !!kemKey, kemKey);
  if (!pds) return { results };

  const sessionRes = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: did, password }),
  });
  const session = await sessionRes.json().catch(() => ({}));
  record('signs in with its own session', sessionRes.ok, sessionRes.ok ? '' : session.error);
  if (!sessionRes.ok) return { results };

  const own = new SpacesClient(bearerCall(pds, session.accessJwt));
  const space = savedSpaceRef(did);

  try {
    const { policy } = await own.getSpace(space);
    record('reads the space config', true, JSON.stringify(policy));
    // An older space (created before Oct 29, or pinned with the removed
    // app-access route) is a memberspace; this converts it as the owner.
    if (toPersonalspace && policy?.$type !== PERSONAL_SPACE_POLICY.$type) {
      await own.updateSpace({ space, policy: PERSONAL_SPACE_POLICY });
      record('converted the space to personalspace', true, `was ${policy?.$type}`);
    }
  } catch (error) {
    record('reads the space config', false, describe(error));
  }

  try {
    const listing = await own.listAllRecords({ space, repo: did, collection: SAVED_COLLECTION });
    record(
      'session read',
      true,
      `${listing.records.length} save(s)${listing.truncated ? ', truncated' : ''}`
    );
  } catch (error) {
    record('session read', false, describe(error));
  }

  let credential;
  let refusal;
  try {
    credential = await mintSpaceCredential({
      space,
      authorityPdsUrl: pds,
      getDelegationToken: async (target) => (await own.getDelegationToken(target)).token,
    });
  } catch (error) {
    refusal = error;
  }
  record('unattested credential is issued', !!credential, credential ? '' : describe(refusal));
  if (!credential || !kemKey) return { results, credentialIssued: !!credential };

  try {
    const reader = new SpacesClient(credentialCall(pds, credential, did, { authorKemKey: kemKey }));
    const listing = await reader.listAllRecords({ space, repo: did, collection: SAVED_COLLECTION });
    const first = listing.records[0];
    if (!first) {
      record('credential read', true, 'space is empty — save something first');
    } else {
      const fetched = await reader.getRecord({
        space,
        repo: did,
        collection: SAVED_COLLECTION,
        rkey: first.rkey,
      });
      record(
        'credential read, MAC + value verified',
        true,
        `${listing.records.length} listed; ${fetched.value?.url ?? first.rkey}`
      );
    }
  } catch (error) {
    record('credential read, MAC + value verified', false, describe(error));
  }
  return { results, credentialIssued: true };
}

async function seedFake(pds) {
  const call = async (endpoint, body, accessJwt) => {
    const response = await fetch(`${pds}/xrpc/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessJwt ? { authorization: `Bearer ${accessJwt}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return response.json();
  };
  const { did } = await call('com.atproto.server.createAccount', {
    handle: 'reader.test',
    password: 'pw',
  });
  const { accessJwt } = await call('com.atproto.server.createSession', {
    identifier: 'reader.test',
    password: 'pw',
  });
  // Skyreader's half, done directly: the space and one mirrored save.
  const { savedRowToSpaceRecord } = await import('../../backend/src/services/spaces/record.ts');
  const { SAVED_SPACE_SKEY, SAVED_SPACE_TYPE } =
    await import('../../backend/src/services/spaces/refs.ts');
  const skyreader = new SpacesClient(bearerCall(pds, accessJwt));
  await skyreader.createSpace({
    spaceType: SAVED_SPACE_TYPE,
    skey: SAVED_SPACE_SKEY,
    // With --to-personalspace, seed what an older space looks like instead.
    policy: TO_PERSONALSPACE
      ? {
          $type: 'com.atproto.memberspace.policy',
          publicRead: false,
          publicWrite: false,
          publishPolicy: false,
          publishMembers: false,
        }
      : PERSONAL_SPACE_POLICY,
  });
  await skyreader.putRecord({
    space: savedSpaceRef(did),
    repo: did,
    collection: SAVED_COLLECTION,
    rkey: '3lsecondclient',
    record: savedRowToSpaceRecord({
      rkey: '3lsecondclient',
      url: 'https://example.com/second-client',
      title: 'Read by another app',
      saved_at: Date.now(),
    }),
  });
  return { did, password: 'pw' };
}

async function main() {
  let did = process.env.SPACES_OWNER_DID;
  let password = process.env.SPACES_PASSWORD;
  let plcUrl = process.env.PLC_URL ?? 'https://plc.directory';

  if (FAKE) {
    const { createFakePds } = await import('./fake-pds.mjs');
    const fake = createFakePds();
    globalThis.fetch = fake.fetch;
    plcUrl = fake.plcOrigin;
    const seeded = await seedFake(fake.origin);
    ({ did, password } = seeded);
  }
  if (!did || !password) {
    console.error('Set SPACES_OWNER_DID and SPACES_PASSWORD (or pass --fake).');
    process.exit(2);
  }

  console.log(`second client reading ${did}\n`);
  const { results: all } = await runSecondClient({
    did,
    password,
    plcUrl,
    toPersonalspace: TO_PERSONALSPACE,
  });
  const failed = all.filter((r) => !r.ok).length;
  console.log(`\n${all.length - failed}/${all.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('\nsecond client aborted:', error);
    process.exit(2);
  });
}
