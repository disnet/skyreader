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
 *   com.atproto.simplespace.{createSpace,getSpace}  (spaceType + read/write policies)
 *   com.atproto.space.{getDelegationToken,getSpaceCredential,
 *                      createRecord,putRecord,getRecord,listRecords,deleteRecord}
 */

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
 * `verifyCredentialSig` does (@atproto/space 0.0.0-spaces-alpha-20261022141228):
 * it must cover exactly `("authorization" "atproto-space-audience")`, carry
 * `tag="atproto-space-credential"`, and verify under the credential's `cnf.kid`.
 */
async function verifyCredentialSig(headers, keyId) {
  const input = /^atproto-space-credential=(\([^)]*\))(.*)$/.exec(
    headers.get('signature-input') ?? ''
  );
  const signature = /^atproto-space-credential=:([A-Za-z0-9+/=]+):$/.exec(
    headers.get('signature') ?? ''
  );
  if (!input || !signature) {
    throw error('BadSpaceSignature', 'missing or malformed atproto-space-credential signature');
  }
  const [, components, params] = input;
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

const KEM_PREFIX = Buffer.concat([
  enc.encode('HPKE-v1'),
  enc.encode('KEM'),
  Buffer.from([0, 0x10]),
]);

/**
 * Repo-host side of the record MAC: decapsulate the reader's `key_share` against
 * the author's KEM key (RFC 9180 DHKEM(P-256, HKDF-SHA256)), then
 * HMAC-SHA256("atproto-space-record-v1" || u16be(len(uri)) || uri || cid).
 */
async function recordMacHeader(kem, wantMac, uri, cidBytes) {
  const keyShare = /^type="atproto-space-record", ver=1, key_share="([^"]+)"$/.exec(wantMac ?? '');
  if (!keyShare) throw error('BadSpaceMac', 'missing or malformed Atproto-Space-Want-Mac');
  const reader = await crypto.subtle.importKey(
    'raw',
    await importDidKeyRaw(keyShare[1]),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
  const readerPub = new Uint8Array(await crypto.subtle.exportKey('raw', reader));
  const dh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: reader }, kem.privateKey, 256)
  );
  const ikm = await crypto.subtle.importKey(
    'raw',
    Buffer.concat([KEM_PREFIX, enc.encode('eae_prk'), dh]),
    'HKDF',
    false,
    ['deriveBits']
  );
  const secret = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: Buffer.concat([
        Buffer.from([0, 32]),
        KEM_PREFIX,
        enc.encode('shared_secret'),
        readerPub,
        kem.pub,
      ]),
    },
    ikm,
    256
  );
  const uriBytes = enc.encode(uri);
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    Buffer.concat([
      enc.encode('atproto-space-record-v1'),
      Buffer.from([uriBytes.length >> 8, uriBytes.length & 0xff]),
      uriBytes,
      cidBytes,
    ])
  );
  return `type="atproto-space-record", ver=1, mac=:${Buffer.from(mac).toString('base64')}:`;
}

/**
 * A record as the fake stores it: the value plus a real CIDv1 (dag-cbor codec,
 * sha-256) — over the JSON rather than the DRISL encoding, which no client here
 * recomputes, but well-formed, because the record MAC covers the CID's bytes.
 */
async function storedRecord(value) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(value)))
  );
  const cidBytes = Uint8Array.from([0x01, 0x71, 0x12, 0x20, ...digest]);
  return { value, cid: `b${base32(cidBytes)}`, cidBytes };
}

function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
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
    throw error('BadSpaceMac', 'key_share must be a P-256 did:key');
  }
  return Uint8Array.from(bytes.slice(2));
}

function error(code, message) {
  const e = new Error(message);
  e.xrpcError = code;
  return e;
}

export function createFakePds(origin = 'https://fake-spaces-pds.test') {
  const accounts = new Map(); // handle -> {did, password, accessJwt}
  const kemKeys = new Map(); // did -> {privateKey, pub, did}
  const sessions = new Map(); // accessJwt -> did
  const spaces = new Map(); // spaceUri -> {authority, readPolicy, writePolicy, appAccess, members:Set}
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

  function assertMember(space, did) {
    if (!space.members.has(did)) throw error('UserNotAuthorized', 'not a member of this space');
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
      const account = accounts.get(body.identifier);
      if (!account || account.password !== body.password) {
        throw error('AuthenticationRequired', 'bad credentials');
      }
      const accessJwt = `access-${next()}`;
      sessions.set(accessJwt, account.did);
      return { did: account.did, handle: body.identifier, accessJwt, refreshJwt: 'refresh' };
    },

    'com.atproto.identity.getRecommendedDidCredentials': async (req) => {
      const did = requireSession(req.headers);
      return { verificationMethods: { atproto_kem: kemKeys.get(did).did } };
    },

    'com.atproto.simplespace.createSpace': async (req, _url, body) => {
      const did = requireSession(req.headers);
      if (!body.spaceType || !body.readPolicy || !body.writePolicy || !body.appAccess) {
        throw error('InvalidRequest', 'spaceType, readPolicy, writePolicy, appAccess required');
      }
      const uri = `at://${did}/space/${body.spaceType}/${body.skey ?? next()}`;
      if (spaces.has(uri)) throw error('SpaceAlreadyExists', 'already exists');
      spaces.set(uri, {
        authority: did,
        readPolicy: body.readPolicy,
        writePolicy: body.writePolicy,
        appAccess: body.appAccess,
        // The owner of a personal space is a member by construction.
        members: new Set([did]),
      });
      return { uri };
    },

    'com.atproto.simplespace.getSpace': async (req, url) => {
      requireSession(req.headers);
      const uri = url.searchParams.get('space');
      const space = requireSpace(uri);
      return {
        uri,
        readPolicy: space.readPolicy,
        writePolicy: space.writePolicy,
        appAccess: space.appAccess,
      };
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

    // Unauthenticated since the Oct 22 alpha: the delegation token and the key
    // to bind (`credentialKid`) both travel in the body. The token is optional
    // in the lexicon (public spaces), but a member-list space gates on the user.
    'com.atproto.space.getSpaceCredential': async (_req, _url, body) => {
      if (!/^did:key:zDn/.test(body?.credentialKid ?? '')) {
        throw error('InvalidRequest', 'credentialKid must be a P-256 did:key');
      }
      await importDidKey(body.credentialKid);
      const space = requireSpace(body.space);
      if (!body.delegationToken) {
        throw error('UserNotAuthorized', 'this space requires a delegation token');
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
      assertMember(space, delegation.did);

      const kid = body.credentialKid;
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

    // With a credential, the read must ask for a MAC (Atproto-Space-Want-Mac)
    // and the answer carries one keyed to the author's KEM key.
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
      const macHeader = await recordMacHeader(
        kemKeys.get(repo),
        req.headers.get('atproto-space-want-mac'),
        uri,
        stored.cidBytes
      );
      return Response.json(body, { headers: { 'atproto-space-mac': macHeader } });
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
      const status = ['SpaceNotFound', 'RecordAlreadyExists', 'RecordNotFound'].includes(
        e.xrpcError
      )
        ? 400
        : 403;
      return Response.json({ error: e.xrpcError, message: e.message }, { status });
    }
  }

  return { origin, fetch: fakeFetch };
}
