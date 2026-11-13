/**
 * An in-process stand-in for a spaces-capable PDS, used by `lifecycle.mjs --fake`.
 *
 * READ THIS BEFORE TRUSTING A GREEN RUN: this is our own reading of the alpha,
 * so a passing `--fake` run says nothing about how the real implementation
 * behaves. What it *does* prove is that the harness works — the client's request
 * shapes, the two-leg credential flow, the HTTP message signatures (verified
 * here with WebCrypto, against the did:key the credential's `cnf.kid` names), the
 * record MAC a credentialed getRecord must negotiate against the author's
 * `#atproto_kem` key, the record mapping, and the fact that the script's privacy
 * assertions actually fire. It
 * turns the live run against a real PDS into a protocol question rather than a
 * "does my script work" question.
 *
 * Implements only what the lifecycle touches:
 *   com.atproto.server.{createAccount,createSession}
 *   com.atproto.identity.getRecommendedDidCredentials  (just the KEM key)
 *   com.atproto.space.{createSpace,getSpace,updateSpace}  (spaceType + one `policy`:
 *                      personalspace or memberspace; getSpace owner-only)
 *   com.atproto.space.{getDelegationToken,authorizeSpaceSync,
 *                      createRecord,putRecord,getRecord,listRecords,deleteRecord}
 * plus a stand-in PLC directory (`plcOrigin`) serving each account's DID doc.
 *
 * App access is enforced where the alpha enforces it — only in
 * authorizeSpaceSync. The fake takes a client attestation's `iss` at its word;
 * the real authority verifies it against the client metadata's JWKS.
 */

import { createHmac } from 'node:crypto';
import { recordCid } from '../../backend/src/services/archive/dag-cbor.ts';

const PERSONALSPACE = 'com.atproto.personalspace.policy';
const MEMBERSPACE = 'com.atproto.memberspace.policy';

const enc = new TextEncoder();

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** P-256 `did:key` → WebCrypto verify key (Node imports compressed points as 'raw'). */
async function importDidKey(did) {
  if (typeof did !== 'string' || !did.startsWith('did:key:z')) {
    throw error('BadSpaceSignature', 'signature key must be a P-256 did:key');
  }
  let n = 0n;
  for (const c of did.slice('did:key:z'.length)) {
    const i = BASE58.indexOf(c);
    if (i < 0) throw error('BadSpaceSignature', 'bad did:key');
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  if (bytes[0] !== 0x80 || bytes[1] !== 0x24 || bytes.length !== 35) {
    throw error('BadSpaceSignature', 'signature key must be a P-256 did:key');
  }
  return crypto.subtle.importKey(
    'raw',
    Uint8Array.from(bytes.slice(2)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
}

/**
 * Verify an `atproto-space-credential` HTTP message signature the way the alpha's
 * `verifyCredentialSig` does (@atproto/space 0.0.0-spaces-alpha-20261112204144):
 * found by its `tag="atproto-space-credential"` under any label, it must cover
 * exactly `("authorization" "atproto-space-audience")` and verify under the
 * credential's `cnf.kid`. (Only one signature per request: the fake doesn't
 * parse a dictionary of several.)
 */
async function verifyCredentialSig(headers, keyId) {
  const input = /^([a-z*][a-z0-9_.*-]*)=(\([^)]*\))(.*)$/.exec(
    headers.get('signature-input') ?? ''
  );
  const signature = input
    ? new RegExp(`^${input[1]}=:([A-Za-z0-9+/=]+):$`).exec(headers.get('signature') ?? '')
    : null;
  if (!input || !signature) {
    throw error('BadSpaceSignature', 'missing or malformed atproto-space-credential signature');
  }
  const [, , components, params] = input;
  const expected = '("authorization" "atproto-space-audience")';
  if (components !== expected) {
    throw error('BadSpaceSignature', `signature must cover exactly ${expected}`);
  }
  if (!/;tag="atproto-space-credential"/.test(params)) {
    throw error('BadSpaceSignature', 'signature tag must be "atproto-space-credential"');
  }
  const keyid = /;keyid="([^"]+)"/.exec(params)?.[1];
  if (keyid !== undefined && keyid !== keyId) {
    throw error('BadSpaceSignature', 'signature keyid does not match the credential key');
  }

  const audience = headers.get('atproto-space-audience');
  if (!audience) throw error('BadSpaceSignature', 'missing atproto-space-audience');
  const lines = [
    `"authorization": ${(headers.get('authorization') ?? '').trim()}`,
    `"atproto-space-audience": ${audience.trim()}`,
    `"@signature-params": ${components}${params}`,
  ];

  const bytes = Buffer.from(signature[1], 'base64');
  const valid =
    bytes.length === 64 &&
    (await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await importDidKey(keyId),
      bytes,
      enc.encode(lines.join('\n'))
    ));
  if (!valid) throw error('BadSpaceSignature', 'invalid HTTP message signature');
}

/** Uncompressed P-256 point → `did:key` (compressed, multicodec p256-pub). */
function p256DidKey(uncompressed) {
  const compressed = [0x02 | (uncompressed[64] & 1), ...uncompressed.subarray(1, 33)];
  let n = 0n;
  for (const b of [0x80, 0x24, ...compressed]) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return `did:key:z${out}`;
}

/** A per-account `#atproto_kem` keypair, as the alpha PDS now creates. */
async function createKemKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, pub, did: p256DidKey(pub) };
}

const u16 = (n) => Buffer.from([n >> 8, n & 0xff]);
const KEM_ID = Buffer.concat([enc.encode('KEM'), u16(0x0010)]);
const SUITE_ID = Buffer.concat([enc.encode('HPKE'), u16(0x0010), u16(0x0001), u16(0xffff)]);
const hmac = (key, data) =>
  createHmac('sha256', key.length ? key : Buffer.alloc(32))
    .update(data)
    .digest();
const labeledExtract = (id, salt, label, ikm) =>
  hmac(salt, Buffer.concat([enc.encode('HPKE-v1'), id, enc.encode(label), ikm]));
const labeledExpand = (id, prk, label, info) =>
  hmac(
    prk,
    Buffer.concat([u16(32), enc.encode('HPKE-v1'), id, enc.encode(label), info, Buffer.from([1])])
  );

/**
 * Repo-host side of the record MAC (Nov 12 alpha): find the `Accept-Signature`
 * request tagged `atproto-space-record`, derive the secret by HPKE secret export
 * (RFC 9180 §6.2, base mode, info "atproto-mac") against the author's KEM key,
 * and answer with an `Atproto-Space-Record` header and an hmac-sha256 RFC 9421
 * signature over it, under the label the reader asked for.
 */
async function recordMacHeaders(kem, acceptSignature, uri, cid) {
  const request =
    /^([a-z*][a-z0-9_.*-]*)=\("atproto-space-record";sf\);keyid="(did:key:[^"]+)";tag="atproto-space-record"$/.exec(
      acceptSignature ?? ''
    );
  if (!request) throw error('InvalidSpaceMac', 'missing or malformed Accept-Signature');
  const [, label, keyShare] = request;
  const reader = await crypto.subtle.importKey(
    'raw',
    await importDidKeyRaw(keyShare),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
  const readerPub = new Uint8Array(await crypto.subtle.exportKey('raw', reader));
  const dh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: reader }, kem.privateKey, 256)
  );
  const empty = Buffer.alloc(0);
  const kemSecret = labeledExpand(
    KEM_ID,
    labeledExtract(KEM_ID, empty, 'eae_prk', dh),
    'shared_secret',
    Buffer.concat([readerPub, kem.pub])
  );
  const context = Buffer.concat([
    Buffer.from([0]),
    labeledExtract(SUITE_ID, empty, 'psk_id_hash', empty),
    labeledExtract(SUITE_ID, empty, 'info_hash', enc.encode('atproto-mac')),
  ]);
  const exporter = labeledExpand(
    SUITE_ID,
    labeledExtract(SUITE_ID, kemSecret, 'secret', empty),
    'exp',
    context
  );
  const secret = labeledExpand(SUITE_ID, exporter, 'sec', empty);

  const record = `uri="${uri}", cid="${cid}"`;
  const params = `("atproto-space-record";sf);keyid="${keyShare}";tag="atproto-space-record"`;
  const mac = hmac(
    secret,
    enc.encode(`"atproto-space-record";sf: ${record}\n"@signature-params": ${params}`)
  );
  return {
    'atproto-space-record': record,
    'signature-input': `${label}=${params}`,
    signature: `${label}=:${mac.toString('base64')}:`,
    vary: 'Accept-Signature',
  };
}

/**
 * A record as the fake stores it: the value plus its real CID (DAG-CBOR,
 * sha-256), since a credentialed reader checks the value against the MAC'd CID.
 */
async function storedRecord(value) {
  const cid = await recordCid(value);
  return { value, cid };
}

/** Compressed point bytes out of a P-256 `did:key`. */
async function importDidKeyRaw(did) {
  let n = 0n;
  for (const c of did.slice('did:key:z'.length)) n = n * 58n + BigInt(BASE58.indexOf(c));
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  if (bytes[0] !== 0x80 || bytes[1] !== 0x24 || bytes.length !== 35) {
    throw error('InvalidSpaceMac', 'keyid must be a P-256 did:key');
  }
  return Uint8Array.from(bytes.slice(2));
}

function error(code, message) {
  const e = new Error(message);
  e.xrpcError = code;
  return e;
}

export function createFakePds(
  origin = 'https://fake-spaces-pds.test',
  plcOrigin = 'https://fake-plc.test'
) {
  const accounts = new Map(); // handle -> {did, password, accessJwt}
  const kemKeys = new Map(); // did -> {privateKey, pub, did}
  const sessions = new Map(); // accessJwt -> did
  const spaces = new Map(); // spaceUri -> {authority, policy, members: Map<did, {read, write}>}
  const repos = new Map(); // `${space}|${did}|${collection}` -> Map<rkey, value>
  const delegations = new Map(); // token -> {did, space, used}
  const credentials = new Map(); // credential -> {did, space, kid, exp}

  let counter = 0;
  const next = () => `${++counter}`;

  function requireSession(headers) {
    const auth = headers.get('authorization') ?? '';
    const did = auth.startsWith('Bearer ') ? sessions.get(auth.slice(7)) : undefined;
    if (!did) throw error('AuthRequired', 'no session');
    return did;
  }

  function requireSpace(uri) {
    const space = spaces.get(uri);
    if (!space) throw error('SpaceNotFound', `no such space: ${uri}`);
    return space;
  }

  /** The alpha's `authorizeUser` for reads: the authority always, then the policy. */
  function canRead(space, did) {
    if (did === space.authority) return true;
    if (space.policy.$type !== MEMBERSPACE) return false; // personalspace: owner only
    return space.policy.publicRead || !!space.members.get(did)?.read;
  }

  function assertMember(space, did) {
    if (!canRead(space, did)) throw error('AccountNotAuthorized', 'not a member of this space');
  }

  /** What the alpha stores: a known `$type`, defaults filled in, unknown fields dropped. */
  function normalizePolicy(policy) {
    if (policy?.$type === PERSONALSPACE) return { $type: PERSONALSPACE };
    if (policy?.$type === MEMBERSPACE) {
      return {
        $type: MEMBERSPACE,
        publicRead: policy.publicRead === true,
        publicWrite: policy.publicWrite === true,
        ...(policy.allowedApps ? { allowedApps: [...policy.allowedApps] } : {}),
        publishPolicy: policy.publishPolicy === true,
        publishMembers: policy.publishMembers === true,
      };
    }
    throw error('UnsupportedPolicy', `unsupported policy: ${policy?.$type}`);
  }

  /**
   * Space access via either a session (own repo) or a space credential. A
   * credential read must be addressed to the repo being read (`audience`), as
   * the alpha's `assertCredentialSpace` requires.
   */
  async function authorize(request, url, spaceUri, repo) {
    const auth = request.headers.get('authorization') ?? '';
    const space = requireSpace(spaceUri);

    if (/^atproto-space-credential /i.test(auth)) {
      const token = auth.slice('Atproto-Space-Credential '.length);
      const record = credentials.get(token);
      if (!record) throw error('InvalidCredential', 'unknown credential');
      if (record.exp * 1000 < Date.now()) throw error('ExpiredToken', 'credential expired');
      await verifyCredentialSig(request.headers, record.kid);
      if (request.headers.get('atproto-space-audience') !== (repo ?? space.authority)) {
        throw error('BadSpaceAudience', 'space audience does not match the request');
      }
      if (record.space !== spaceUri) {
        throw error('InvalidCredential', 'Credential is not scoped to this space');
      }
      assertMember(space, record.did);
      return { did: record.did, credential: true };
    }

    const did = requireSession(request.headers);
    assertMember(space, did);
    return { did, credential: false };
  }

  const handlers = {
    'com.atproto.server.createAccount': async (_req, _url, body) => {
      if (accounts.has(body.handle)) throw error('HandleNotAvailable', 'taken');
      const did = `did:plc:fake${next()}`;
      accounts.set(body.handle, { did, password: body.password });
      kemKeys.set(did, await createKemKey());
      return { did, handle: body.handle };
    },

    'com.atproto.server.createSession': async (_req, _url, body) => {
      const account =
        accounts.get(body.identifier) ??
        [...accounts.values()].find((a) => a.did === body.identifier);
      if (!account || account.password !== body.password) {
        throw error('AuthenticationRequired', 'bad credentials');
      }
      const accessJwt = `access-${next()}`;
      sessions.set(accessJwt, account.did);
      return { did: account.did, accessJwt, refreshJwt: 'refresh' };
    },

    'com.atproto.identity.getRecommendedDidCredentials': async (req) => {
      const did = requireSession(req.headers);
      return { verificationMethods: { atproto_kem: kemKeys.get(did).did } };
    },

    'com.atproto.space.createSpace': async (req, _url, body) => {
      const did = requireSession(req.headers);
      if (!body.spaceType || !body.policy) {
        throw error('InvalidRequest', 'spaceType and policy required');
      }
      const policy = normalizePolicy(body.policy);
      const uri = `at://${did}/space/${body.spaceType}/${body.skey ?? next()}`;
      if (spaces.has(uri)) throw error('SpaceAlreadyExists', 'already exists');
      spaces.set(uri, { authority: did, policy, members: new Map() });
      return { space: uri };
    },

    // Owner-only since the Oct 29 alpha; a space credential never reaches it.
    'com.atproto.space.getSpace': async (req, url) => {
      if (/^atproto-space-credential /i.test(req.headers.get('authorization') ?? '')) {
        throw error('AuthRequired', 'getSpace takes OAuth, not a space credential');
      }
      const did = requireSession(req.headers);
      const uri = url.searchParams.get('space');
      const space = requireSpace(uri);
      if (space.authority !== did) throw error('NotAuthorized', 'not the space owner');
      return { space: uri, policy: space.policy };
    },

    'com.atproto.space.getDelegationToken': async (req, url) => {
      const did = requireSession(req.headers);
      const uri = url.searchParams.get('space');
      requireSpace(uri);
      // Note: issued to anyone with a session. The *credential* exchange is
      // where membership is enforced.
      const token = `deleg-${next()}`;
      delegations.set(token, { did, space: uri, exp: Math.floor(Date.now() / 1000) + 60 });
      return { token };
    },

    // The policy is replaced wholesale; a new `$type` discards the member list.
    'com.atproto.space.updateSpace': async (req, _url, body) => {
      const did = requireSession(req.headers);
      const space = requireSpace(body.space);
      if (space.authority !== did) throw error('NotAuthorized', 'not the space owner');
      if (!body.policy) throw error('InvalidRequest', 'policy required');
      const policy = normalizePolicy(body.policy);
      if (policy.$type !== space.policy.$type) space.members = new Map();
      space.policy = policy;
      return {};
    },

    // Unauthenticated since the Oct 22 alpha: the delegation token and the key
    // to bind (`credentialKey`; `credentialKid` before the Nov 12 alpha renamed
    // getSpaceCredential to authorizeSpaceSync) both travel in the body. The token is optional
    // in the lexicon (public spaces), but only a `publicRead` memberspace issues
    // without one. Since Oct 29 the user is checked before the app, and a user
    // the policy refuses gets `SpaceNotFound`, which discloses nothing.
    'com.atproto.space.authorizeSpaceSync': async (_req, _url, body) => {
      if (!/^did:key:zDn/.test(body?.credentialKey ?? '')) {
        throw error('InvalidRequest', 'credentialKey must be a P-256 did:key');
      }
      await importDidKey(body.credentialKey);
      const space = requireSpace(body.space);
      if (!body.delegationToken) {
        // The spike never creates a public space, so the fake doesn't issue here.
        throw error('SpaceNotFound', 'Space not found');
      }
      const delegation = delegations.get(body.delegationToken);
      if (!delegation) throw error('InvalidDelegationToken', 'unknown delegation token');
      delegations.delete(body.delegationToken); // single use
      if (delegation.exp * 1000 < Date.now()) {
        throw error('InvalidDelegationToken', 'delegation expired');
      }
      if (delegation.space !== body.space) {
        throw error('InvalidDelegationToken', 'delegation is for another space');
      }
      if (!canRead(space, delegation.did)) throw error('SpaceNotFound', 'Space not found');
      const allowedApps = space.policy.allowedApps;
      if (allowedApps) {
        let clientId;
        try {
          clientId = JSON.parse(Buffer.from(body.clientAttestation.split('.')[1], 'base64url')).iss;
        } catch {
          clientId = undefined;
        }
        if (!clientId || !allowedApps.includes(clientId)) {
          throw error('AppNotAuthorized', 'Application not authorized for this space');
        }
      }

      const kid = body.credentialKey;
      const exp = Math.floor(Date.now() / 1000) + 600;
      const credential = `${b64urlJson({ typ: 'atproto-space-credential+jwt', alg: 'ES256' })}.${b64urlJson(
        { iss: space.authority, sub: body.space, exp, jti: next(), cnf: { kid } }
      )}.sig`;
      credentials.set(credential, { did: delegation.did, space: body.space, kid, exp });
      return { credential };
    },

    'com.atproto.space.createRecord': async (req, url, body) => {
      const { did } = await authorize(req, url, body.space, body.repo);
      if (did !== body.repo) throw error('NotAuthorized', 'can only write your own repo');
      const key = `${body.space}|${body.repo}|${body.collection}`;
      const collection = repos.get(key) ?? new Map();
      const rkey = body.rkey ?? next();
      if (collection.has(rkey)) throw error('RecordAlreadyExists', 'rkey taken');
      const stored = await storedRecord(body.record);
      collection.set(rkey, stored);
      repos.set(key, collection);
      return {
        uri: `${body.space}/${body.repo}/${body.collection}/${rkey}`,
        cid: stored.cid,
        validationStatus: 'unknown',
      };
    },

    // What the backend mirror actually writes with: an upsert at a caller-chosen
    // rkey, so a replayed save is idempotent rather than RecordAlreadyExists.
    'com.atproto.space.putRecord': async (req, url, body) => {
      const { did } = await authorize(req, url, body.space, body.repo);
      if (did !== body.repo) throw error('NotAuthorized', 'can only write your own repo');
      if (!body.rkey) throw error('InvalidRequest', 'rkey required');
      const key = `${body.space}|${body.repo}|${body.collection}`;
      const collection = repos.get(key) ?? new Map();
      const stored = await storedRecord(body.record);
      collection.set(body.rkey, stored);
      repos.set(key, collection);
      return {
        uri: `${body.space}/${body.repo}/${body.collection}/${body.rkey}`,
        cid: stored.cid,
        validationStatus: 'unknown',
      };
    },

    // With a credential, the read must ask for a MAC (Accept-Signature) and the
    // answer carries one keyed to the author's KEM key.
    'com.atproto.space.getRecord': async (req, url) => {
      const space = url.searchParams.get('space');
      const repo = url.searchParams.get('repo');
      const { credential } = await authorize(req, url, space, repo);
      const collection = repos.get(`${space}|${repo}|${url.searchParams.get('collection')}`);
      const stored = collection?.get(url.searchParams.get('rkey'));
      if (!stored) throw error('RecordNotFound', 'no such record');
      const uri = `${space}/${repo}/${url.searchParams.get('collection')}/${url.searchParams.get('rkey')}`;
      const body = { uri, cid: stored.cid, value: stored.value };
      if (!credential) return body;
      const headers = await recordMacHeaders(
        kemKeys.get(repo),
        req.headers.get('accept-signature'),
        uri,
        stored.cid
      );
      return Response.json(body, { headers });
    },

    'com.atproto.space.listRecords': async (req, url) => {
      const space = url.searchParams.get('space');
      await authorize(req, url, space, url.searchParams.get('repo'));
      const collectionName = url.searchParams.get('collection');
      const collection = repos.get(`${space}|${url.searchParams.get('repo')}|${collectionName}`);
      return {
        records: [...(collection ?? new Map())].map(([rkey, stored]) => ({
          collection: collectionName,
          rkey,
          cid: stored.cid,
          value: stored.value,
        })),
      };
    },

    'com.atproto.space.deleteRecord': async (req, url, body) => {
      const { did } = await authorize(req, url, body.space, body.repo);
      if (did !== body.repo) throw error('NotAuthorized', 'can only write your own repo');
      repos.get(`${body.space}|${body.repo}|${body.collection}`)?.delete(body.rkey);
      return {};
    },
  };

  /** A drop-in `fetch` serving the above. */
  async function fakeFetch(input, init = {}) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === plcOrigin) return didDocResponse(decodeURIComponent(url.pathname.slice(1)));
    if (url.origin !== origin) throw new Error(`fake PDS got a request for ${url.origin}`);

    const nsid = url.pathname.replace('/xrpc/', '');
    const handler = handlers[nsid];
    if (!handler) {
      return Response.json({ error: 'MethodNotImplemented', message: nsid }, { status: 501 });
    }

    let body;
    if (request.method === 'POST') {
      const text = await request.text();
      body = text ? JSON.parse(text) : undefined;
    }

    try {
      const result = await handler(request, url, body);
      return result instanceof Response ? result : Response.json(result);
    } catch (e) {
      if (!e.xrpcError) throw e;
      // The alpha throws these as InvalidRequestError (400); the rest are auth refusals.
      const status = [
        'SpaceNotFound',
        'RecordAlreadyExists',
        'RecordNotFound',
        'NotAuthorized',
        'UnsupportedPolicy',
        'AppNotAuthorized',
        'PolicyMismatch',
      ].includes(e.xrpcError)
        ? 400
        : 403;
      return Response.json({ error: e.xrpcError, message: e.message }, { status });
    }
  }

  /** A PLC-shaped DID doc: Multikey verification methods and the PDS service. */
  function didDocResponse(did) {
    const kem = kemKeys.get(did);
    if (!kem) return Response.json({ message: `DID not registered: ${did}` }, { status: 404 });
    return Response.json({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      verificationMethod: [
        {
          id: `${did}#atproto_kem`,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: kem.did.slice('did:key:'.length),
        },
      ],
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: origin }],
    });
  }

  return { origin, plcOrigin, fetch: fakeFetch };
}
