/**
 * An in-process stand-in for a spaces-capable PDS, used by `lifecycle.mjs --fake`.
 *
 * READ THIS BEFORE TRUSTING A GREEN RUN: this is our own reading of the alpha,
 * so a passing `--fake` run says nothing about how the real implementation
 * behaves. What it *does* prove is that the harness works — the client's request
 * shapes, the three-leg credential flow, the HTTP message signatures (verified
 * here with WebCrypto, against the did:key the credential's `cnf.kid` names), the record
 * mapping, and the fact that the script's privacy assertions actually fire. It
 * turns the live run against a real PDS into a protocol question rather than a
 * "does my script work" question.
 *
 * Implements only what the lifecycle touches:
 *   com.atproto.server.{createAccount,createSession}
 *   com.atproto.simplespace.{createSpace,getSpace}  (spaceType + read/write policies)
 *   com.atproto.space.{getDelegationToken,getSpaceCredential,
 *                      createRecord,getRecord,listRecords,deleteRecord}
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
 * Verify an `atproto-space` HTTP message signature the way the alpha's
 * `verifySpaceSignature` does (@atproto/space 0.0.0-spaces-alpha-20261001173819).
 * Without `keyId` (obtaining a credential) the signature must cover exactly
 * `("authorization")` and name its key as `keyid`; with one (presenting a
 * credential) it must cover `("authorization" "atproto-space-audience")` and
 * verify under the credential's `cnf.kid`. Returns the signing key's did:key.
 */
async function verifySpaceSignature(headers, keyId) {
  const input = /^atproto-space=(\([^)]*\))(.*)$/.exec(headers.get('signature-input') ?? '');
  const signature = /^atproto-space=:([A-Za-z0-9+/=]+):$/.exec(headers.get('signature') ?? '');
  if (!input || !signature) {
    throw error('BadSpaceSignature', 'missing or malformed atproto-space signature');
  }
  const [, components, params] = input;
  const expected =
    keyId === undefined ? '("authorization")' : '("authorization" "atproto-space-audience")';
  if (components !== expected) {
    throw error('BadSpaceSignature', `signature must cover exactly ${expected}`);
  }
  const keyid = /;keyid="([^"]+)"/.exec(params)?.[1];
  const signingKey = keyId ?? keyid;
  if (keyId !== undefined && keyid !== undefined && keyid !== keyId) {
    throw error('BadSpaceSignature', 'signature keyid does not match the credential key');
  }

  const authorization = headers.get('authorization') ?? '';
  const lines = [`"authorization": ${authorization.trim()}`];
  if (keyId !== undefined) {
    const audience = headers.get('atproto-space-audience');
    if (!audience) throw error('BadSpaceSignature', 'missing atproto-space-audience');
    lines.push(`"atproto-space-audience": ${audience.trim()}`);
  }
  lines.push(`"@signature-params": ${components}${params}`);

  const bytes = Buffer.from(signature[1], 'base64');
  const valid =
    bytes.length === 64 &&
    (await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await importDidKey(signingKey),
      bytes,
      enc.encode(lines.join('\n'))
    ));
  if (!valid) throw error('BadSpaceSignature', 'invalid HTTP message signature');
  return signingKey;
}

function error(code, message) {
  const e = new Error(message);
  e.xrpcError = code;
  return e;
}

export function createFakePds(origin = 'https://fake-spaces-pds.test') {
  const accounts = new Map(); // handle -> {did, password, accessJwt}
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

    if (/^atproto-space /i.test(auth)) {
      const token = auth.slice('Atproto-Space '.length);
      const record = credentials.get(token);
      if (!record) throw error('InvalidCredential', 'unknown credential');
      if (record.exp * 1000 < Date.now()) throw error('ExpiredToken', 'credential expired');
      await verifySpaceSignature(request.headers, record.kid);
      if (request.headers.get('atproto-space-audience') !== (repo ?? space.authority)) {
        throw error('BadSpaceAudience', 'space audience does not match the request');
      }
      if (record.space !== spaceUri) {
        throw error('InvalidCredential', 'Credential is not scoped to this space');
      }
      assertMember(space, record.did);
      return record.did;
    }

    const did = requireSession(request.headers);
    assertMember(space, did);
    return did;
  }

  const handlers = {
    'com.atproto.server.createAccount': async (_req, _url, body) => {
      if (accounts.has(body.handle)) throw error('HandleNotAvailable', 'taken');
      const did = `did:plc:fake${next()}`;
      accounts.set(body.handle, { did, password: body.password });
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

    'com.atproto.space.getSpaceCredential': async (req, url, body) => {
      const auth = req.headers.get('authorization') ?? '';
      if (!auth.startsWith('Bearer ')) throw error('InvalidDelegationToken', 'expected Bearer');
      const delegation = delegations.get(auth.slice(7));
      if (!delegation) throw error('InvalidDelegationToken', 'unknown delegation token');
      delegations.delete(auth.slice(7)); // single use
      if (delegation.exp * 1000 < Date.now()) {
        throw error('InvalidDelegationToken', 'delegation expired');
      }
      if (delegation.space !== body.space) {
        throw error('InvalidDelegationToken', 'delegation is for another space');
      }

      const space = requireSpace(body.space);
      assertMember(space, delegation.did);

      const kid = await verifySpaceSignature(req.headers);
      const exp = Math.floor(Date.now() / 1000) + 600;
      const credential = `${b64urlJson({ typ: 'atproto-space-credential+jwt', alg: 'ES256' })}.${b64urlJson(
        { iss: space.authority, sub: body.space, exp, jti: next(), cnf: { kid } }
      )}.sig`;
      credentials.set(credential, { did: delegation.did, space: body.space, kid, exp });
      return { credential };
    },

    'com.atproto.space.createRecord': async (req, url, body) => {
      const did = await authorize(req, url, body.space, body.repo);
      if (did !== body.repo) throw error('NotAuthorized', 'can only write your own repo');
      const key = `${body.space}|${body.repo}|${body.collection}`;
      const collection = repos.get(key) ?? new Map();
      const rkey = body.rkey ?? next();
      if (collection.has(rkey)) throw error('RecordAlreadyExists', 'rkey taken');
      collection.set(rkey, body.record);
      repos.set(key, collection);
      return {
        uri: `${body.space}/${body.repo}/${body.collection}/${rkey}`,
        cid: `cid-${next()}`,
        validationStatus: 'unknown',
      };
    },

    'com.atproto.space.getRecord': async (req, url) => {
      const space = url.searchParams.get('space');
      await authorize(req, url, space, url.searchParams.get('repo'));
      const collection = repos.get(
        `${space}|${url.searchParams.get('repo')}|${url.searchParams.get('collection')}`
      );
      const value = collection?.get(url.searchParams.get('rkey'));
      if (!value) throw error('RecordNotFound', 'no such record');
      return {
        uri: `${space}/${url.searchParams.get('repo')}/${url.searchParams.get('collection')}/${url.searchParams.get('rkey')}`,
        cid: 'cid-x',
        value,
      };
    },

    'com.atproto.space.listRecords': async (req, url) => {
      const space = url.searchParams.get('space');
      await authorize(req, url, space, url.searchParams.get('repo'));
      const collectionName = url.searchParams.get('collection');
      const collection = repos.get(`${space}|${url.searchParams.get('repo')}|${collectionName}`);
      return {
        records: [...(collection ?? new Map())].map(([rkey, value]) => ({
          collection: collectionName,
          rkey,
          cid: 'cid-x',
          value,
        })),
      };
    },

    'com.atproto.space.deleteRecord': async (req, url, body) => {
      const did = await authorize(req, url, body.space, body.repo);
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
      return Response.json(await handler(request, url, body));
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
