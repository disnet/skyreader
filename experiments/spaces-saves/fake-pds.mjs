/**
 * An in-process stand-in for a spaces-capable PDS, used by `lifecycle.mjs --fake`.
 *
 * READ THIS BEFORE TRUSTING A GREEN RUN: this is our own reading of the alpha,
 * so a passing `--fake` run says nothing about how the real implementation
 * behaves. What it *does* prove is that the harness works — the client's request
 * shapes, the three-leg credential flow, the DPoP proofs (verified here with
 * WebCrypto, against the key the credential's `cnf.jkt` names), the record
 * mapping, and the fact that the script's privacy assertions actually fire. It
 * turns the live run against a real PDS into a protocol question rather than a
 * "does my script work" question.
 *
 * Implements only what the lifecycle touches:
 *   com.atproto.server.{createAccount,createSession}
 *   com.atproto.simplespace.{createSpace,getSpace}
 *   com.atproto.space.{getDelegationToken,getSpaceCredential,
 *                      createRecord,getRecord,listRecords,deleteRecord}
 */

const enc = new TextEncoder();

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}
function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function decodeJwt(jwt) {
  const [header, payload] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
  };
}

async function sha256b64url(input) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input))));
}

/** RFC 7638 thumbprint of an EC public JWK. */
async function jkt(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(canonical))));
}

/** Verify a DPoP proof the way the alpha's `verifyDpopProof` does. */
async function verifyDpopProof(proof, { htm, htu, credential, expectedJkt }) {
  const [header, payload, signature] = proof.split('.');
  const { header: h, payload: p } = decodeJwt(proof);
  if (h.typ !== 'dpop+jwt' || h.alg !== 'ES256') throw error('BadDpopProof', 'bad proof header');

  const key = await crypto.subtle.importKey(
    'jwk',
    { ...h.jwk, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(signature, 'base64url'),
    enc.encode(`${header}.${payload}`)
  );
  if (!valid) throw error('BadDpopProofSignature', 'proof signature does not verify');
  if (p.htm !== htm) throw error('BadDpopProof', 'htm mismatch');

  const normalized = new URL(htu);
  if (p.htu !== normalized.origin + normalized.pathname) {
    throw error('BadDpopProof', `htu mismatch: ${p.htu}`);
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - p.iat) > 60) {
    throw error('DpopProofExpired', 'iat outside the 60s window');
  }
  if (credential === undefined) {
    if (p.ath !== undefined) throw error('BadDpopProof', 'ath must be omitted when obtaining');
  } else if (p.ath !== (await sha256b64url(credential))) {
    throw error('BadDpopProof', 'ath does not match the credential');
  }

  const thumbprint = await jkt(h.jwk);
  if (expectedJkt !== undefined && thumbprint !== expectedJkt) {
    throw error('DpopKeyMismatch', 'proof is not signed by the bound key');
  }
  return thumbprint;
}

function error(code, message) {
  const e = new Error(message);
  e.xrpcError = code;
  return e;
}

export function createFakePds(origin = 'https://fake-spaces-pds.test') {
  const accounts = new Map(); // handle -> {did, password, accessJwt}
  const sessions = new Map(); // accessJwt -> did
  const spaces = new Map(); // spaceUri -> {authority, policy, appAccess, members:Set}
  const repos = new Map(); // `${space}|${did}|${collection}` -> Map<rkey, value>
  const delegations = new Map(); // token -> {did, space, used}
  const credentials = new Map(); // credential -> {did, space, jkt, exp}

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

  /** Space access via either a session (own repo) or a space credential. */
  async function authorize(request, url, spaceUri) {
    const auth = request.headers.get('authorization') ?? '';
    const space = requireSpace(spaceUri);

    if (auth.startsWith('DPoP ')) {
      const token = auth.slice(5);
      const record = credentials.get(token);
      if (!record) throw error('InvalidCredential', 'unknown credential');
      if (record.space !== spaceUri)
        throw error('NotAuthorized', 'credential is for another space');
      if (record.exp * 1000 < Date.now()) throw error('InvalidCredential', 'credential expired');
      await verifyDpopProof(request.headers.get('dpop') ?? '', {
        htm: request.method,
        htu: url.toString(),
        credential: token,
        expectedJkt: record.jkt,
      });
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
      const uri = `at://${did}/space/${body.type}/${body.skey ?? next()}`;
      if (spaces.has(uri)) throw error('SpaceAlreadyExists', 'already exists');
      spaces.set(uri, {
        authority: did,
        policy: body.policy,
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
      return { uri, policy: space.policy, appAccess: space.appAccess };
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

      const thumbprint = await verifyDpopProof(req.headers.get('dpop') ?? '', {
        htm: 'POST',
        htu: url.toString(),
      });
      const exp = Math.floor(Date.now() / 1000) + 7200;
      const credential = `${b64urlJson({ typ: 'atproto-space-credential+jwt', alg: 'ES256' })}.${b64urlJson(
        { iss: space.authority, sub: delegation.did, exp, cnf: { jkt: thumbprint } }
      )}.sig`;
      credentials.set(credential, { did: delegation.did, space: body.space, jkt: thumbprint, exp });
      return { credential };
    },

    'com.atproto.space.createRecord': async (req, url, body) => {
      const did = await authorize(req, url, body.space);
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
      await authorize(req, url, space);
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
      await authorize(req, url, space);
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
      const did = await authorize(req, url, body.space);
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
