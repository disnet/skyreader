# OAuth scopes: permission sets and progressive requests

How Skyreader decides what to ask a reader's PDS for, and how to change it. Background:
[Permission Sets](https://atproto.com/guides/permission-sets),
[OAuth Patterns → progressive scope requests](https://atproto.com/guides/oauth-patterns#progressive-scope-requests),
[Permissions spec](https://atproto.com/specs/permission).

Code: `backend/src/config/scopes.ts` (what we ask for), `backend/src/services/scope-check.ts`
(whether a session holds it), `backend/src/routes/auth.ts` (login, `POST /api/auth/upgrade`,
callback).

## The model

**Sign-in asks for the base only:**

| Scope                                                          | Why it's in the base                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `atproto`                                                      | Required                                                                       |
| `include:app.skyreader.authFull` (or its granular equivalents) | Subscriptions, follows, reading rooms, recommends: Skyreader's own collections |
| `repo:site.standard.graph.subscription`                        | The standard.site follow-graph mirror rides Atmospheric sync in the background |
| `repo:site.standard.graph.recommend`                           | The standard.site copy of a recommend (best-effort; skipped without it)        |
| `repo:dev.at-intent.usage`                                     | The AT Intents discovery record written at sign-in                             |

**Optional features ask when first used.** Each is a `ScopeFeature` in `SCOPE_FEATURES`:

| Feature    | Scopes (granular)                                          | With permission sets on                            |
| ---------- | ---------------------------------------------------------- | -------------------------------------------------- |
| `semble`   | `network.cosmik.card/collection/collectionLink/connection` | `include:network.cosmik.authFull` + `connection`   |
| `margin`   | `at.margin.note/collection/collectionItem`                 | same (granular)                                    |
| `linkblog` | `site.standard.publication/document`                       | `include:site.standard.authFull`                   |
| `pckt`     | linkblog + `blog.pckt.document`                            | linkblog + `blog.pckt.document`                    |
| `offprint` | linkblog + `app.offprint.document.article`                 | linkblog + `app.offprint.document.article`         |
| `feedback` | `app.userinput.discussion/upvote` + `blob:image/*`         | `include:app.userinput.authBasic` + `blob:image/*` |
| `follows`  | `rpc:app.bsky.feed.getTimeline?aud=*` (see below)          | same (granular)                                    |

**`follows` asks for `aud=*` but gates on the appview.** The feature only ever proxies
getTimeline to `did:web:api.bsky.app#bsky_appview`, and gates check that
(`FOLLOWS_LINKS_ACCESS_SCOPES`). It requests `aud=*` because rsky (Blacksky's PDS) compares an
`rpc:` grant against the proxy target's bare DID, so the spec-correct `…%23bsky_appview` grant is
refused there with `403 InsufficientScope`. Sessions holding the narrow grant keep working on the
reference PDS. On rsky, the refresh stores `last_error = 'scope_denied'` and the route answers
`scopeRequired: true`, so the reader grants again and gets `aud=*`. Drop back to the narrow scope
once rsky matches the full `did#service` audience.

A gated route answers `403 { error: 'scope_upgrade_required', feature }`. The frontend offers
"Allow access", which calls `POST /api/auth/upgrade { features, returnUrl }`. That starts a new
authorization for base + everything the session already holds + the new feature, with the
reader's DID as `login_hint`. The callback stores the new session and retires the one the
upgrade started from (same DID only). The reader stays signed in throughout.

**Granted features are remembered.** The callback writes the features the reader actually
granted (they can untick scopes on the consent screen) to `users.oauth_features`, and the next
sign-in asks for them again. It also unions in whatever the account's live sessions hold, which
is what carries sessions from before progressive scopes (granted everything) through their first
sign-in without losing an integration.

**Scope checks are semantic.** A PDS returns a permission set expanded, as
`repo?collection=a&collection=b`, not `repo:a repo:b`. Every gate goes through `grantsScopes()`
(built on `@atproto/oauth-scopes`), never string matching on `granted_scopes`.

**Client metadata `scope` is the ceiling**, not what sign-in asks for (`clientMetadataScopes()`).
Every request must fit inside it. For the localhost public client it is baked into the
`client_id`, so login, callback, refresh and revoke must all use the same value.

## The permission set

`lexicons/app/skyreader/authFull.json` defines `app.skyreader.authFull`: repo access to
every `app.skyreader.*` collection Skyreader writes. A set can only name resources under its own
namespace (`app.skyreader.`), so other apps' collections come from their own sets (below) or
stay granular.

Why bother: the consent screen shows the set's `title`/`detail` instead of one line per
collection. And **the PDS re-resolves the set on every token refresh**, so adding a new
`app.skyreader.*` collection to the set reaches live sessions without a re-auth. Refresh writes
the new scope back to `sessions.granted_scopes`. Before sets, every new collection meant the
"log in again" dance (see the comments on `READING_ROOM_SCOPES`, `AT_INTENT_SCOPES`, etc.).

### Publishing the lexicons (one-time, then on every change)

The set and every `app.skyreader.*` record schema are published together from the repo-root
`lexicons/` directory. A PDS resolves `include:app.skyreader.authFull` like any lexicon: it drops
the last NSID segment, reverses the rest into a domain, reads the DNS TXT record
`_lexicon.<domain>`, then fetches the `com.atproto.lexicon.schema` record whose rkey is the NSID
from that DID's repo. Every NSID group needs its own TXT record, so `app.skyreader.authFull`
resolves via `_lexicon.skyreader.app` but `app.skyreader.feed.subscription` via
`_lexicon.feed.skyreader.app`.

1. Pick the account that publishes Skyreader's lexicons (the Skyreader account). Log in with
   [goat](https://github.com/bluesky-social/goat) using an app password, and note the DID:

   ```bash
   goat account login -u <handle> -p <app-password>
   goat account status
   ```

2. Add one TXT record per NSID group in the `skyreader.app` zone, each `"did=<that DID>"`:

   | Name                             | Covers                    |
   | -------------------------------- | ------------------------- |
   | `_lexicon.skyreader.app`         | `app.skyreader.authFull`  |
   | `_lexicon.feed.skyreader.app`    | `app.skyreader.feed.*`    |
   | `_lexicon.reading.skyreader.app` | `app.skyreader.reading.*` |
   | `_lexicon.social.skyreader.app`  | `app.skyreader.social.*`  |

   A new group (say `app.skyreader.linkblog.*`) needs a new record before it can publish.

3. From the repo root (goat's default `--lexicons-dir` is `lexicons/`):

   ```bash
   goat lex lint lexicons/
   goat lex check-dns        # every group should resolve to the DID
   goat lex breaking         # on updates: refuse changes that break evolution rules
   goat lex publish          # first publish; add --update to change existing schemas
   goat lex status           # all in sync
   ```

4. Verify from the network: `goat lex resolve app.skyreader.authFull` (and one record NSID, e.g.
   `app.skyreader.feed.subscription`) returns the schema.
5. Turn it on: set `OAUTH_PERMISSION_SETS = "true"` in `backend/wrangler.toml` (staging first,
   under `[env.staging]` `vars`), deploy, sign in, check the consent screen shows "Skyreader".

**Order matters.** A PDS refuses the whole authorization (`invalid_scope`) if it can't resolve an
included set. Sign-in then retries with granular scopes (see below), so that isn't an outage, but
every reader would silently get the one-line-per-collection consent screen. So publish before
flipping the flag, and never remove a collection from the published set that live code still
writes.

Existing sessions are unaffected either way: their granular grants satisfy the same checks.

## Other apps' permission sets

A client can `include:` any published set, not just its own. When `OAUTH_PERMISSION_SETS` is on,
a feature asks through the owning app's set where one fits (`FEATURE_PERMISSION_SET_SCOPES` in
`scopes.ts`), plus granular scopes for whatever the set leaves out:

| Set                       | Used by                  | Leaves out                     |
| ------------------------- | ------------------------ | ------------------------------ |
| `site.standard.authFull`  | linkblog, pckt, offprint | nothing we write               |
| `network.cosmik.authFull` | semble                   | `network.cosmik.connection`    |
| `app.userinput.authBasic` | feedback                 | `blob:image/*` (sets are repo) |

Not used, on purpose: `at.margin.authFull`, `blog.pckt.authFull` and `app.offprint.authFull` are
"full access" sets (Margin's covers API keys and preferences), far broader than the few
collections we write. `dev.at-intent` publishes no set.

Two things to know:

- **Their outages are mostly absorbed.** The reference PDS (`@atproto/oauth-provider`) keeps the
  last copy of a set it resolved and serves that when a lookup fails, rechecking every 5 minutes.
  Refreshes and sign-ins on a PDS that has seen the set are unaffected. A PDS that has never
  resolved it answers the PAR with `invalid_scope`, and `buildAuthorizationUrl` retries once with
  the same features as granular scopes, so the reader signs in and sees one consent line per
  collection. Grants are equivalent either way. The localhost public client has no PAR, so there
  the error comes back to the callback and isn't retried.
- **They control the contents.** The PDS re-resolves on every refresh. If an app drops a
  collection we write, sessions lose it and "Allow access" can't win it back. The copies in
  `backend/src/config/external-permission-sets.ts` are snapshots (checked against our gates in
  `test/oauth-scopes.spec.ts`); compare them with `goat lex resolve <nsid>` when something
  looks off, and drop the feature back to granular if a set stops fitting.

## Adding a scope

- **A new `app.skyreader.*` collection:** add it to `authFull.json` and to
  `SKYREADER_REPO_SCOPES` (`test/oauth-scopes.spec.ts` keeps the two in sync), then republish the
  set. Sessions pick it up on their next refresh. Only sessions created while
  `OAUTH_PERMISSION_SETS` was off need an upgrade, and the route's 403 handles that.
- **Another app's collection for an existing feature:** add it to that feature's list in
  `SCOPE_FEATURES` and to `ALL_POSSIBLE_SCOPES`. If the feature asks through a set that doesn't
  cover it, add it to the feature's `FEATURE_PERMISSION_SET_SCOPES` entry too (the spec fails
  until you do). Sessions that lack it get a 403 with that feature and one "Allow access" click.
- **A new optional feature:** add a `ScopeFeature`, its entry in `SCOPE_FEATURES`, its label in
  the frontend's `SCOPE_FEATURE_LABELS`, and return `insufficientScopesResponse('<feature>')`
  from its gate.
