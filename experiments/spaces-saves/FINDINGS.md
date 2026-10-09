# Findings: atproto Spaces, as of the alpha

Phase 0 of the saved-articles spike. What the alpha's API surface actually is,
where it diverges from proposal 0016, and what it costs to use.

**Status of these findings.** Everything below marked _observed_ was read off the
published alpha artifacts — the SDK's generated lexicon types and the reference
app's client code — at the pinned versions in the next section. Everything marked
_unverified_ needs a run of `npm run lifecycle` against a real spaces PDS, which
has not happened yet: this environment has no Docker and no BPS invite, and
`@atproto/pds@alpha` will not resolve here. The harness is written and green
against an in-process fake (`npm run lifecycle:fake`, 11/11), so the live run is
a protocol question, not a "does the script work" question.

## Pinned versions

| Artifact         | Version / ref                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `@atproto/api`   | `0.0.0-spaces-alpha-20261001173819` (npm tag `alpha`; first read at `…20260818163953`)            |
| `@atproto/space` | `0.0.0-spaces-alpha-20261001173819`                                                               |
| `@atproto/pds`   | `0.0.0-spaces-alpha-20261001173819`                                                               |
| Reference app    | `bluesky-social/bulletin`, `main`, read 2026-08-23 (not re-read for the October update)           |
| Proposal         | `bluesky-social/proposals` `0016-permissioned-data`                                               |
| PDS image        | `ghcr.io/bluesky-social/atproto:pds-spaces-alpha` (digest not pinned — fill in on first live run) |

The alpha updates on Thursdays with breaking changes, so treat every shape below
as accurate for that snapshot and nothing later. The spike was first written
against `…20260818163953`; [what changed since](#what-changed-through-20261001173819)
is listed at the end, and the client, tests and fake PDS follow the October shape.
There is still no stable release with Spaces: `@atproto/pds@0.5.38` (2026-10-07)
ships no `space` or `simplespace` handlers.

## The API surface, as implemented _(observed)_

Two namespaces, not one:

**`com.atproto.simplespace.*`** — the space authority. Session-authed, called on
the authority's own PDS.

| Method                        | Input                                                    | Output / notes                                                                                                               |
| ----------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `createSpace`                 | `{spaceType, skey?, readPolicy, writePolicy, appAccess}` | `{uri}`. `skey` auto-generates a TID when omitted. Errors: `SpaceAlreadyExists`, `UnsupportedPolicy`, `UnsupportedAppAccess` |
| `getSpace`                    | `?space=`                                                | `{uri, readPolicy, writePolicy, appAccess}`. Error: `SpaceNotFound`                                                          |
| `updateSpace` / `deleteSpace` | `{space, …}`                                             | `updateSpace` replaces `readPolicy` / `writePolicy` wholesale when given                                                     |
| `putMember` / `removeMember`  | `{space, did, read, write}` / `{space, did}`             | `putMember` is an upsert. Errors: `SpaceNotFound`, `NotSpaceOwner`                                                           |
| `listMembers`                 | `?space=`                                                | `members: [{did, read, write}]`                                                                                              |
| `checkUserAccess`             | `?space=&user=&access=&clientId?=`                       | `{authorized}` — the callback a `managingApp` policy makes _to the app_, for `read` and (since September) `write`            |

`readPolicy` decides who may read the space; `writePolicy` decides whose write
notifications the authority tracks and forwards to syncers — it does not gate
writing to your own repo. Both take the same union. Policies are `$type`-tagged
unions in `com.atproto.simplespace.defs`:
`#publicPolicy`, `#memberListPolicy` (default), `#managingAppPolicy{managingApp}`.
App access: `#open` or `#allowList{allowed: string[]}` — evaluated against the
attested OAuth `client_id`.

**`com.atproto.space.*`** — the permissioned repo.

| Method                                                                                         | Input                                                                                   |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `createRecord`                                                                                 | `{space, repo, collection, rkey?, validate?, record}` → `{uri, cid, validationStatus?}` |
| `putRecord` / `deleteRecord` / `applyWrites`                                                   | `{space, repo, collection, rkey, …}`                                                    |
| `getRecord`                                                                                    | `?space=&repo=&collection=&rkey=`                                                       |
| `listRecords`                                                                                  | `?space=&repo=&collection?&limit?&cursor?&reverse?&excludeValues?`                      |
| `getDelegationToken`                                                                           | `?space=` → `{token}`                                                                   |
| `getSpaceCredential`                                                                           | `{space, clientAttestation?}` → `{credential}`                                          |
| `listRepoOps`, `getLatestCommit`, `getRepo`, `listRepos`, `listSpaces`, `getBlob`, `listBlobs` | sync/read surface                                                                       |
| `registerNotify`, `unregisterNotify`, `notifyWrite`, `notifySpaceDeleted`                      | push-style sync                                                                         |

Error codes worth branching on: `SpaceNotFound`, `SpaceDeleted`,
`UserNotAuthorized`, `AppNotAuthorized`, `NotAuthorized`,
`InvalidDelegationToken`, `InvalidClientAttestation`, `RecordAlreadyExists`,
`RecordNotFound`, plus the repo-state family (`RepoNotFound`, `RepoTakendown`,
`RepoSuspended`, `RepoDeactivated`). Credential auth adds `BadSpaceSignature`,
`BadSpaceAudience`, `CredentialRevoked`, `JwtReplayed` and `BadJwtCnf`. A
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
   August alpha — the reference app just doesn't use it. Whether the hosted
   alpha's auth server accepts it as a direct request is _unverified_.
   Actions are `read_self | read | create | update | delete` (`read` implies
   `read_self`; the default is everything but `read_self`); `authority` accepts a
   DID, `self` or `*`, and `skey` defaults to `*`.

3. **The space type needs no lexicon document.** _(observed)_ It is just an NSID.
   The reference app ships none for `my.bulletin.board`.

4. **`createSpace` takes no member list.** _(observed)_ Policy and app-access
   only; membership is managed afterwards via `putMember` (`addMember` until the
   September alpha). For a personal space (authority = the user) the owner is a
   member by construction, so the spike never calls `putMember` —
   **`ensureSavedSpace` assumes this**, and it is the first thing a live run
   should confirm.

5. **Credentials are bound by HTTP message signatures, not DPoP.** _(observed,
   October alpha)_ Leg 2 sends `Authorization: Bearer <delegation>` plus an
   `atproto-space` signature over that header whose `keyid` is a fresh P-256
   `did:key`; the returned credential names that key in `cnf.kid`. Legs 3+ send
   `Authorization: Atproto-Space <credential>`, an `atproto-space-audience: <did>`
   header, and a signature over both (no `keyid`). The audience is the **repo
   DID** being read for record methods, and the space authority for space-host
   methods (`listRepos`, `registerNotify`, …) — so one credential reading several
   members' repos signs once per repo. Until the October alpha this leg was DPoP
   (`cnf.jkt`, `Authorization: DPoP`, an `ath`-less proof to obtain).

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

Signature details (`dist/http-signature.js`): label `atproto-space`; ES256 only
(`alg`, if present, must be `ecdsa-p256-sha256`); the signature base is each
covered header as `"name": value`, then `"@signature-params": <inner list>`,
newline-joined; the signature is the 64-byte compact `r‖s`, base64 in a
structured-field byte sequence. No part of the URL or method is signed.

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

The Docker image name and whether it tracks the October build are _unverified_
(the registry tag listing needs auth).
