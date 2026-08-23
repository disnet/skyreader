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
| `@atproto/api`   | `0.0.0-spaces-alpha-20260818163953` (npm tag `alpha`)                                             |
| `@atproto/space` | `0.0.0-spaces-alpha-20260818163953`                                                               |
| `@atproto/pds`   | `0.0.0-spaces-alpha-20260818163953`                                                               |
| Reference app    | `bluesky-social/bulletin`, `main`, read 2026-08-23                                                |
| Proposal         | `bluesky-social/proposals` `0016-permissioned-data`                                               |
| PDS image        | `ghcr.io/bluesky-social/atproto:pds-spaces-alpha` (digest not pinned — fill in on first live run) |

The alpha updates on Thursdays with breaking changes, so treat every shape below
as accurate for that snapshot and nothing later.

## The API surface, as implemented _(observed)_

Two namespaces, not one:

**`com.atproto.simplespace.*`** — the space authority. Session-authed, called on
the authority's own PDS.

| Method                        | Input                              | Output / notes                                                                                                               |
| ----------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `createSpace`                 | `{type, skey?, policy, appAccess}` | `{uri}`. `skey` auto-generates a TID when omitted. Errors: `SpaceAlreadyExists`, `UnsupportedPolicy`, `UnsupportedAppAccess` |
| `getSpace`                    | `?space=`                          | `{uri, policy, appAccess}`. Error: `SpaceNotFound`                                                                           |
| `updateSpace` / `deleteSpace` | `{space, …}`                       | —                                                                                                                            |
| `addMember` / `removeMember`  | `{space, did}`                     | Errors: `SpaceNotFound`, `NotSpaceOwner`                                                                                     |
| `listMembers`                 | `?space=`                          | —                                                                                                                            |
| `checkUserAccess`             | `?space=&user=&clientId=`          | `{authorized}` — the callback a `managingApp` policy makes _to the app_                                                      |

Policies are `$type`-tagged unions in `com.atproto.simplespace.defs`:
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
`RepoSuspended`, `RepoDeactivated`).

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

2. **There is no `space:` OAuth scope.** _(observed)_ The plan expected
   `space:<spaceType>?authority=…`. What the reference app actually requests is
   `include:my.bulletin.permissions` — an NSID naming a **permission-set
   lexicon** whose entries are `{type: permission, resource: "space", spaceType,
authority, skey, collection[], action[], manage[]}`. Our equivalent is
   committed as `app.skyreader.space.savedAccess`.

3. **The space type needs no lexicon document.** _(observed)_ It is just an NSID.
   The reference app ships none for `my.bulletin.board`.

4. **`createSpace` takes no member list.** _(observed)_ Policy and app-access
   only; membership is managed afterwards via `addMember`. For a personal space
   (authority = the user) the owner is a member by construction, so the spike
   never calls `addMember` — **`ensureSavedSpace` assumes this**, and it is the
   first thing a live run should confirm.

5. **The credential exchange presents the delegation as `Bearer`, not `DPoP`.**
   _(observed)_ Leg 2 sends `Authorization: Bearer <delegation>` plus a DPoP proof
   from a fresh key; the returned credential is bound to that key via `cnf.jkt`,
   and legs 3+ send `Authorization: DPoP <credential>`.

## Token lifetimes and round-trip cost _(observed from `@atproto/space`)_

`SPACE_TOKEN_TYPES` in `dist/credential.d.ts`:

| Token              | `typ`                            | TTL   | Single use | DPoP-bound               |
| ------------------ | -------------------------------- | ----- | ---------- | ------------------------ |
| delegation         | `atproto-space-delegation+jwt`   | 60s   | yes        | no                       |
| **credential**     | `atproto-space-credential+jwt`   | 7200s | no         | yes (`cnf.jkt` required) |
| client attestation | `atproto-client-attestation+jwt` | 60s   | yes        | no                       |

So a cold credential costs **two round trips**, and then two hours of reuse. Clock
skew allowance is 5s; a DPoP proof is valid for 60s.

That 2h/reusable shape is what makes an in-memory, per-isolate cache the right
call for Workers (`services/spaces/credential.ts`): a cold isolate re-mints, and
we never write the bound private key to D1. Persisting the key would turn a
two-hour token into durable stored key material for an alpha protocol.

DPoP proof details (`dist/dpop.js`): ES256 only; `htu` is normalized to
origin+path, so one proof covers any query string; `ath` is
`base64url(sha256(credential))` and **must be omitted** on the leg that obtains a
credential.

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
