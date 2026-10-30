# Findings: atproto Spaces, as of the alpha

Phase 0 of the saved-articles spike. What the alpha's API surface actually is,
where it diverges from proposal 0016, and what it costs to use.

**Status of these findings.** Everything below marked _observed_ was read off the
published alpha artifacts — the SDK's generated lexicon types and the reference
app's client code — at the pinned versions in the next section. Everything marked
_unverified_ needs a run of `npm run lifecycle` against a real spaces PDS, which
has not happened yet: this environment has no Docker and no BPS invite, and
`@atproto/pds@alpha` will not resolve here. The harness is written and green
against an in-process fake (`npm run lifecycle:fake`, 15/15 — it writes with `putRecord`, the call the backend mirror uses), so the live run is
a protocol question, not a "does the script work" question.

## Pinned versions

| Artifact         | Version / ref                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `@atproto/api`   | `0.0.0-spaces-alpha-20261029171913` (npm tag `alpha`; first read at `…20260818163953`)            |
| `@atproto/space` | `0.0.0-spaces-alpha-20261029171913`                                                               |
| `@atproto/pds`   | `0.0.0-spaces-alpha-20261029171913`                                                               |
| Reference app    | `bluesky-social/bulletin`, `main`, read 2026-08-23 (not re-read for the October update)           |
| Proposal         | `bluesky-social/proposals` `0016-permissioned-data`                                               |
| PDS image        | `ghcr.io/bluesky-social/atproto:pds-spaces-alpha` (digest not pinned — fill in on first live run) |

The alpha updates on Thursdays with breaking changes, so treat every shape below
as accurate for that snapshot and nothing later. The spike was first written
against `…20260818163953`; what changed since is listed at the end
([through Oct 1](#what-changed-through-20261001173819),
[Oct 22](#what-changed-in-20261022141228),
[Oct 29](#what-changed-in-20261029171913)), and the client, tests and fake PDS
follow the Oct 29 shape. Bluesky's Oct 22 notes called this the last breaking
alpha before a beta at the end of November; whether more follow is _unverified_.
There is still no stable release with Spaces: `@atproto/pds@0.5.38` (2026-10-07)
ships no `space` or `simplespace` handlers.

Note the alpha packages can't be installed from npm as published: their
manifests still carry `workspace:*` ranges. The cross-checks below load the
relevant `dist/` files out of the tarballs instead.

## The API surface, as implemented _(observed)_

Since Oct 29 there is no `com.atproto.simplespace`. The policy-agnostic
lifecycle lives in `com.atproto.space`, and each policy's own methods in its own
namespace. All session-authed, called on the authority's own PDS:

| Method                                   | Input                                        | Output / notes                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `space.createSpace`                      | `{spaceType, skey?, policy}`                 | `{uri}`. `skey` auto-generates a TID when omitted. Errors: `SpaceAlreadyExists`, `UnsupportedPolicy`                                           |
| `space.getSpace`                         | `?space=`                                    | `{uri, policy}`. **Owner only** (OAuth `read_self`); a space credential is refused. Errors: `SpaceNotFound`, `NotSpaceOwner`                   |
| `space.updateSpace`                      | `{space, policy}`                            | Replaces the policy wholesale (send the whole object). A new `$type` migrates the space and discards the old policy state                      |
| `space.deleteSpace`                      | `{space}`                                    | Shape unchanged from `simplespace`                                                                                                             |
| `memberspace.putMember` / `removeMember` | `{space, did, read, write}` / `{space, did}` | `putMember` is an upsert. `PolicyMismatch` on a non-memberspace. `removeMember`, and `putMember` with `write: false`, now also drop the writer |
| `memberspace.listMembers`                | `?space=&limit?&cursor?`                     | `members: [{did, read, write}]`                                                                                                                |
| `managedspace.checkUserAccess`           | `?space=&user=&access=&clientId?=`           | `{authorized}` — the callback a `managedspace` authority makes _to the managing app_, for reads and writes                                     |

`policy` is an open union on `$type`; every PDS supports three:

- `com.atproto.personalspace.policy` — no fields. Only the authority's account
  reads, and no other writers are tracked. **No app allow-list.**
- `com.atproto.memberspace.policy` — `publicRead`, `publicWrite`,
  `allowedApps?` (OAuth client_ids; checked against the attested client when a
  credential is issued), `publishPolicy`, `publishMembers`. Booleans default to
  false.
- `com.atproto.managedspace.policy` — `managingApp`, `publishPolicy`. Every user
  decision goes to the managing app.

Under every policy the authority's own account may read and write.

**`com.atproto.space.*`** — the permissioned repo.

| Method                                                                                         | Input                                                                                   |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `createRecord`                                                                                 | `{space, repo, collection, rkey?, validate?, record}` → `{uri, cid, validationStatus?}` |
| `putRecord` / `deleteRecord` / `applyWrites`                                                   | `{space, repo, collection, rkey, …}`                                                    |
| `getRecord`                                                                                    | `?space=&repo=&collection=&rkey=`; with a credential, needs `Atproto-Space-Want-Mac`    |
| `listRecords`                                                                                  | `?space=&repo=&collection?&limit?&cursor?&reverse?&excludeValues?`                      |
| `getDelegationToken`                                                                           | `?space=` → `{token}`                                                                   |
| `getSpaceCredential`                                                                           | `{space, credentialKid, delegationToken?, clientAttestation?}` → `{credential}`         |
| `listRepoOps`, `getLatestCommit`, `getRepo`, `listRepos`, `listSpaces`, `getBlob`, `listBlobs` | sync/read surface                                                                       |
| `registerNotify`, `unregisterNotify`, `notifyWrite`, `notifySpaceDeleted`                      | push-style sync                                                                         |

Error codes worth branching on: `SpaceNotFound` (since Oct 29 also what a user
the policy refuses gets from `getSpaceCredential`: "not found or not
authorized"), `SpaceDeleted`, `UserNotAuthorized` (other authorities may still
send it), `AppNotAuthorized` (only once the user passed), `NotAuthorized`,
`InvalidDelegationToken`, `InvalidClientAttestation`, `RecordAlreadyExists`,
`RecordNotFound`, plus the repo-state family (`RepoNotFound`, `RepoTakendown`,
`RepoSuspended`, `RepoDeactivated`). Credential auth adds `BadSpaceSignature`,
`BadSpaceAudience`, `CredentialRevoked`, `JwtReplayed` and `BadJwtCnf`, and a
credentialed read of a commit or record adds `BadSpaceMac`. A
session reading a repo that isn't its own gets `RepoNotFound` — deliberately the
same answer as an absent repo.

Space refs are `at://{authorityDid}/space/{type}/{skey}` (string format
`space-ref`); a record inside one is
`at://{authorityDid}/space/{type}/{skey}/{authorDid}/{collection}/{rkey}`.

## Where the implementation differs from what the plan assumed

1. **Writing to your own repo needs no credential at all.** _(observed)_ The plan
   (following proposal 0016) assumed every space call rides a space credential.
   The reference app calls `com.atproto.space.createRecord` with the ordinary
   OAuth session client against the user's own PDS. Credentials are for reading a
   space from somewhere that isn't the author's authenticated session — i.e.
   cross-host sync and other members' repos.

   **This is the single biggest finding for us.** A personal-space mirror of D1
   saves is a plain authenticated XRPC POST — the existing `PDSClient` shape, no
   new auth machinery on the write path. The credential flow is only needed for
   the thing that makes the spike interesting: proving a _different_ client can
   read the data.

2. **Space access is requested through a permission set.** _(observed)_ What the
   reference app requests is `include:my.bulletin.permissions` — an NSID naming
   a **permission-set lexicon** whose entries are `{type: permission, resource:
"space", spaceType, authority, skey, collection[], action[], manage[]}`. Our
   equivalent is committed as `app.skyreader.space.savedAccess`. _Correction:_ an
   earlier version of this file said there is no `space:` scope at all. There is
   — `@atproto/oauth-scopes` has parsed a bare
   `space:<type>?authority=…&skey=…&collection=…&action=…&manage=…` since the
   August alpha — the reference app just doesn't use it. The hosted alpha's auth
   server accepts it as a direct request _(observed, Oct 22 alpha)_, subject to
   the declaration lookup in finding 3.
   Actions are `read_self | read | create | update | delete` (`read` implies
   `read_self`; the default is everything but `read_self`); `authority` accepts a
   DID, `self` or `*`, and `skey` defaults to `*`.

3. **OAuth needs a published space declaration for the space type.** _(observed,
   Oct 22 alpha)_ An earlier version of this file said the space type needs no
   lexicon document, since the reference app shipped none for
   `my.bulletin.board`. That holds for the space and record XRPCs on a password
   session, but not for OAuth. The auth server's `LexiconManager` resolves every
   concrete type in a `space:` scope (bare, or expanded from an `include:`
   permission set) to a published lexicon whose `main` def is
   `{type: "space", key, name, collections[]}`. If it can't, `/oauth/authorize`
   redirects back with `invalid_scope` / "Unable to retrieve space declarations"
   before the sign-in screen. At token issuance it also fills a bare
   `space:<type>` grant's `collection` from the declaration's `collections`. A
   wildcard type (`space:*`) skips the lookup. The dev sign-in uses that
   (`SAVED_SPACE_SCOPE` in `backend/src/config/scopes.ts`) because
   `app.skyreader.space.saved` isn't published (no
   `_lexicon.space.skyreader.app` record). Publishing the declaration would let
   the scope name the type again.

4. **`createSpace` takes no member list.** _(observed)_ Policy only (app access
   too, before Oct 29); membership is managed afterwards via `putMember`
   (`addMember` until the September alpha). For a personal space (authority = the
   user) the owner needs no entry: since Oct 29 every policy authorizes the
   authority's own account outright (`SpacePolicyManager.authorizeUser`), so the
   spike never calls `putMember`.

5. **Credentials are bound by HTTP message signatures, not DPoP.** _(observed,
   Oct 22 alpha)_ Leg 2 (`getSpaceCredential`) is an **unauthenticated** POST
   whose body carries the space, the delegation token and a fresh P-256
   `did:key` as `credentialKid`; the returned credential names that key in
   `cnf.kid`. Nothing is signed to obtain it — possession of the key is proved on
   first use. Every request after that sends
   `Authorization: Atproto-Space-Credential <credential>`, an
   `atproto-space-audience: <did>` header, and an `atproto-space-credential`
   signature over both, tagged `tag="atproto-space-credential"`. The audience is
   the **repo DID** being read for record methods, and the space authority for
   space-host methods (`listRepos`, `registerNotify`, …) — so one credential
   reading several members' repos signs once per repo. The delegation token is
   optional in the lexicon: a public space issues credentials without one. Ours
   is member-list, so it still needs one.

   History: until Oct 1 this was DPoP (`cnf.jkt`). From Oct 1 to Oct 22, leg 2
   sent `Authorization: Bearer <delegation>` with an `atproto-space` signature
   carrying `keyid`, and credentials were presented as `Atproto-Space`.

6. **Reading a record with a credential needs a MAC handshake.** _(observed, Oct
   22 alpha)_ Space-repo commits are no longer signed. Instead each account has
   an `#atproto_kem` P-256 key in its DID doc, and a credentialed call to
   `getRecord`, `getRepo`, `getLatestCommit` or `listRepoOps` must send
   `Atproto-Space-Want-Mac: type="atproto-space-record", ver=1, key_share="did:key:…"`
   (type `atproto-space-repo` for commits) with a fresh ephemeral key. The host
   answers with `Atproto-Space-Mac: …, mac=:…:`, an HMAC-SHA256 keyed by an RFC
   9180 DHKEM(P-256, HKDF-SHA256) secret derived from that key share and the
   author's KEM key. Without the header the read fails with `BadSpaceMac`.
   `listRecords` returns neither commits nor MACs and needs no header — and so
   carries no authentication of the records it returns.

   For us, a second client reading a save now needs the owner's KEM key (public,
   in their DID doc) as well as a credential. The MAC covers only the uri and
   CID, so, like the alpha's own `verifyRecord`, `credentialCall` also requires
   the uri to be the one requested and the value to encode (DAG-CBOR) to that
   CID, and refuses a credentialed `getRecord` outright when it has no KEM key. `services/spaces/kem.ts`
   implements the record MAC on WebCrypto plus `@noble/curves`. It was
   cross-checked against the alpha's own `decapsulate` / `computeRecordMac` /
   `parseWantMacHeader` (20/20 random rounds), and `spaces-kem.spec.ts` pins a
   fixed vector produced by them. Commit MACs aren't implemented: the spike
   reads no commits.

   Existing accounts get their KEM key from a one-time backfill on PDS startup,
   which publishes a PLC update per account. did:web accounts must add it by
   hand. **Until an account's key is published, nobody can sync its space
   repos.**

## Token lifetimes and round-trip cost _(observed from `@atproto/space`)_

`SPACE_TOKEN_TYPES` in `dist/credential.d.ts`:

| Token              | `typ`                            | TTL                           | Single use | Key-bound                |
| ------------------ | -------------------------------- | ----------------------------- | ---------- | ------------------------ |
| delegation         | `atproto-space-delegation+jwt`   | 60s                           | yes        | no                       |
| **credential**     | `atproto-space-credential+jwt`   | 600s (verifiers cap at 3600s) | no         | yes (`cnf.kid` required) |
| client attestation | `atproto-client-attestation+jwt` | 60s                           | yes        | no                       |

Every token type now requires a `jti`, and an authority can revoke credentials
by `jti` (`com.atproto.space.notifyCredentialRevoked`). The credential was 7200s
until the October alpha.

So a cold credential costs **two round trips**, and then ten minutes of reuse.
Clock skew allowance is 5s.

That short-lived, reusable shape is still what makes an in-memory, per-isolate
cache the right call for Workers (`services/spaces/credential.ts`): a cold
isolate re-mints, and we never write the bound private key to D1. Persisting the
key would turn a short-lived token into durable stored key material for an alpha
protocol. The shorter TTL makes re-mints more frequent, not more dangerous.

Signature details (`dist/http-signature.js`): label and `tag` both
`atproto-space-credential`; covers exactly `("authorization"
"atproto-space-audience")`, in that order; ES256 only (`alg`, if present, must be
`ecdsa-p256-sha256`); a `keyid`, if present, must equal `cnf.kid`. The signature
base is each covered header as `"name": value`, then
`"@signature-params": <inner list>`, newline-joined; the signature is the 64-byte
compact `r‖s`, base64 in a structured-field byte sequence. No part of the URL or
method is signed. `http-signature.ts` was cross-checked against the alpha's
`verifyCredentialSig` (20/20, and a retargeted audience is rejected).

## A second app reading the space _(observed from the alpha source; live run pending)_

Follow-up spike 1. `second-client.mjs` plays an app that isn't Skyreader: it
resolves the reader's DID doc through PLC for the PDS and `#atproto_kem` key,
signs in with its own session, and tries both read paths. Read off
`@atproto/pds` / `@atproto/space` at `…20261022141228`, and re-read at
`…20261029171913`, where it still holds with the names changed
(`appAccess` → memberspace `allowedApps`, `SimpleSpaceManager` →
`SpacePolicyManager`):

- **App access gates credentials, not sessions.** `allowedApps` is checked in one
  place, `SpacePolicyManager.authorizeCredential`, when `getSpaceCredential`
  issues a credential, after the user check. A session read of the reader's own repo
  (`assertSpaceRead`) never looks at it. So `allowedApps` decides which apps can
  _sync_ the space; what an app can read through the reader's own session is
  decided by the OAuth scopes the reader granted it (`space:` permissions), and
  a password session has them all. "Private to Skyreader" would therefore need
  both the allow-list for credentials and the reader not granting other apps a
  `space:` scope. **Decision (Oct 30): not pursued.** Portability to the apps a
  reader chooses is the point, the allow-list never gated writes or session
  reads anyway, and OAuth consent already decides which apps get in. The
  saved-space is a `personalspace`, which has no allow-list at all.
- **App identity is a client attestation.** `getSpaceCredential` takes an
  optional `clientAttestation`: a `private_key_jwt`-shaped JWT, `typ`
  `atproto-client-attestation+jwt`, `iss` = `sub` = the client_id,
  `aud` = `<spaceDid>#atproto_pds`, 60s, single-use `jti`. The authority fetches
  the client_id's metadata and verifies the signature against its `jwks` (or
  `jwks_uri`). Without one, a space with `allowedApps` answers `AppNotAuthorized`.
  `createClientAttestation` (`services/client-auth.ts`) signs one with
  Skyreader's existing client key.
- **Only a confidential client can be on an allowList.** Local dev runs as the
  localhost public client, which publishes no keys, so pinning a space to it
  locks every credential out, Skyreader's own included. Proving "Skyreader
  allowed, others refused" end to end needs a deployed client with
  `CLIENT_SIGNING_KEY` and the spike flag on.
- **App passwords can't get delegation tokens.** `getDelegationToken` requires
  full access (`com.atproto.access`), so an app-password session can't mint a
  credential. The second client uses the test account's password, or would
  need OAuth with a `space:` read permission for the space.

How to run it: in a dev session, save something, then
`SPACES_OWNER_DID=… SPACES_PASSWORD=… npm run second-client`: the unattested
credential is issued and the MAC-verified read succeeds.
`GET /api/dev/spaces/credential-read` is Skyreader's own read through the
credential path, with an attestation when it is a confidential client.
`npm run second-client:fake` runs it against the fake (7/7). (The allow-list
toggle, `POST /api/dev/spaces/app-access`, was removed with the decision above.)

## Latency, size limits, sync — _unverified_

Not measurable without a live PDS. A live run should record:

- wall-clock for each leg of the credential flow (the script prints it);
- whether `validate` defaults to validating known lexicons, and what
  `validationStatus` comes back as for `app.skyreader.feed.saved` once the
  lexicon is resolvable;
- the record size ceiling (our records are metadata-only and ~300–600 bytes, so
  this is about headroom, not risk);
- whether `listRepoOps` / `getLatestCommit` give a usable incremental cursor for a
  future reconciliation job, and whether `registerNotify` is reachable from
  Workers at all;
- whether a fresh account on the hosted alpha has its `#atproto_kem` key in its
  published DID doc straight away, or only after the backfill;
- whether `getDelegationToken` is issued to any session (as our fake assumes) or
  gated on membership — that determines whether "outsider denied" fails at leg 1
  or leg 2.
- whether the hosted alpha's auth server grants
  `include:app.skyreader.space.savedAccess` as written. The scope parser accepts
  `authority: "self"` (and `"*"`), so the permission set now uses `self` — each
  user's own DID, exactly a personal space's authority — but the grant path
  itself hasn't been exercised.

## Alpha operational reality

No backups, destructive migrations, weekly breaking changes, the sandbox PDS gets
deleted at the end of the alpha, and production use is explicitly prohibited. No
production PDS — bsky.social or otherwise — implements Spaces today. That is why
`SPACES_SAVES_ENABLED` exists only in `.dev.vars` and why the capability probe
caches its negative verdict.

## Out of scope, deliberately

- **Backed saves** (Semble/Margin). Backing already makes a save portable and
  public; layering a private space mirror on top is a product question, not a
  protocol one. A tester with backing on sees an empty space — start from an
  account with backing off.
- **Content updates** (`handleContentUpdate` / `handleUpdateSaved`). The space
  record is metadata-only, so what a content upgrade changes is mostly the body.
  The residual drift (a stale `wordCount` or `title`) shows up in the dev
  `saved-diff` route as `mismatched`, which is the honest way to carry it: the
  fix is a reconciliation pass, not more write hooks.
- **The OAuth flow.** The spike does not touch `config/scopes.ts`. Adding an
  alpha `include:` scope would push every existing user through re-auth and risks
  the scope-string reconstruction on the refresh path.

## What changed through `…20261001173819`

Read by diffing the npm tarballs of `@atproto/{api,pds,space,oauth-scopes,syntax}`
between `0.0.0-spaces-alpha-20260818163953` and `0.0.0-spaces-alpha-20261001173819`
(the `alpha` tag as of 2026-10-09). Releases landed Sep 10, 13 and 15 and Oct 1,
not weekly. Breaking for this spike, and all now handled:

| Change                                                                  | Landed | Where it hit us                       |
| ----------------------------------------------------------------------- | ------ | ------------------------------------- |
| `policy` split into `readPolicy` + `writePolicy` (create/get/update)    | Sep 10 | `createSpace` input, `getSpace` view  |
| `addMember` removed; `putMember {space, did, read, write}` added        | Sep 10 | `SpacesClient`                        |
| `listMembers` entries gain `read` / `write`                             | Sep 10 | `SpacesClient` types                  |
| `createSpace` `type` renamed `spaceType` (and `listSpaces ?spaceType=`) | Oct 1  | `createSpace` input                   |
| DPoP replaced by `atproto-space` HTTP message signatures + audience     | Oct 1  | `http-signature.ts`, credential, fake |
| Credential TTL 7200s → 600s; `jti` required; `cnf.jkt` → `cnf.kid`      | Oct 1  | credential cache expectations         |

Not breaking for us, noted for a reconciliation job: `notifyWrite` renamed
`rev` → `repoRev` and gained `spaceRev` / `prevSpaceRev` (a gap means missed
notifications; delivery is now retried for 24h); `listRepos` entries carry
`repoRev` + `spaceRev`, with the cursor now a `spaceRev`;
`notifyCredentialRevoked` is new. Unchanged: the record methods
(`createRecord` / `putRecord` / `deleteRecord` / `getRecord` / `listRecords`),
`getDelegationToken`, the `simplespace.defs` policy/app-access shapes, space and
record URI formats, and own-repo writes on plain session auth. `@atproto/syntax`
now validates the skey, collection and rkey segments of a space URI strictly.

## What changed in `…20261022141228`

Read by diffing the same tarballs between `…20261001173819` and
`…20261022141228` (`…20261015143509` in between), alongside Bluesky's Oct 22
release notes on the Atmosphere forum. Bluesky called it the largest alpha
release so far.

| Change                                                                                                  | Spec PR / impl         | Where it hit us                                           |
| ------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------- |
| Public spaces: `getSpaceCredential` takes `{credentialKid, delegationToken?}` in the body, unsigned     | proposals #120 / #5690 | `exchangeSpaceCredential`, fake                           |
| Signature label + tag `atproto-space-credential`; auth scheme `Atproto-Space-Credential`                | #120 / #5690           | `http-signature.ts`, `SpaceCredential.authorize`, fake    |
| Shared-secret commits: per-account `#atproto_kem` key; credentialed record/commit reads need a MAC      | #122 / #5706           | new `kem.ts`; `credentialCall` takes `authorKemKey`, fake |
| Commit field `hash` → `data` (`listRepos`, `getLatestCommit`); `signedCommit` → unsigned `commit`       | #122 / #5706           | none (no commit reads)                                    |
| `getRepo` returns a STAR archive, not a CAR; `excludeValues` removed                                    | #114 / #5705           | none (no `getRepo`)                                       |
| DID doc: space-host signing key and service entry removed; `#atproto_pds` is the host, `#atproto` signs | #123 / #5691           | none (we already address the authority's PDS)             |
| `notifySpaceDeleted` retried until delivered or the syncer's registration expires                       | #124 / #5697           | none (no syncer)                                          |

Unchanged on the wire (until Oct 29, below): everything in `com.atproto.simplespace.*` (`deleteSpace` now also queues `notifySpaceDeleted`), the record write methods,
`listRecords`, `getDelegationToken`, the space/record URI formats, own-repo
writes on plain session auth, and `@atproto/oauth-scopes`. All spec changes are
collected in proposals PR #125.

Self-hosting the alpha PDS now needs migrations on both the account-manager and
actor-store databases plus the KEM backfill; the atproto repo carries an agent
prompt for it at `alpha-migrations/prompt-10-22-26.md`. The image was also
rebuilt on a newer Node after the eMudhra CA compromise.

The Docker image name and whether it tracks the latest build are _unverified_
(the registry tag listing needs auth).

## What changed in `…20261029171913`

Read off the `…20261029171913` tarballs (`@atproto/api` types, `@atproto/pds`
`space-policy/`) alongside Bluesky's agent prompt
`alpha-migrations/prompt-10-29-26.md`.

| Change                                                                                                        | Spec PR / impl         | Where it hit us                                                             |
| ------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| `simplespace` removed; create/get/update/deleteSpace move to `com.atproto.space`                              | proposals #119 / #5764 | `SpacesClient`, mirror, fake, tests                                         |
| `readPolicy` + `writePolicy` + `appAccess` → one `policy` (`personalspace` / `memberspace` / `managedspace`)  | #119 / #5764           | `PERSONAL_SPACE_POLICY`, second client, (since removed) app-access route    |
| `updateSpace` replaces the policy wholesale; `{space, policy}` both required                                  | #119 / #5764           | the (since removed) app-access route reads the policy and sends it all back |
| `getSpace` is owner-only; a credential is refused                                                             | #119 / #5764           | none (only the owner calls it), fake                                        |
| Member methods move to `com.atproto.memberspace`; `PolicyMismatch` elsewhere                                  | #119 / #5764           | `SpacesClient` (unused by the spike)                                        |
| `getSpaceCredential` checks the user first; a refused user gets `SpaceNotFound`, not `UserNotAuthorized`      | #119 / #5764           | lifecycle's outsider step accepts it; fake                                  |
| `removeWriter`, `clearRecords`, `importRepo`, `exportSpaceMeta` / `importSpaceMeta`; published policy records | #128, #127, #129       | none (optional; not added)                                                  |

The saved-space is now created as a `com.atproto.personalspace.policy`: only the
owner reads, and no other writer is tracked. It has no app allow-list, so any app
the reader gives a delegation token gets a credential; that is deliberate (see
"A second app reading the space").

A space created on the Oct 22 alpha is converted by the reference PDS's
actor-store migration `006-space-policy` to a memberspace with no members and
nothing public. It stays readable only by its owner and keeps working, but the
mirror creates a space only when none exists, so it stays a memberspace. To
match new spaces, run `npm run second-client -- --to-personalspace` once (the
same goes for a space pinned with the removed allow-list toggle).
