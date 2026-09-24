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
| `include:app.skyreader.authFull` (or its granular equivalents) | Subscriptions, follows, reading rooms: Skyreader's own collections             |
| `repo:site.standard.graph.subscription`                        | The standard.site follow-graph mirror rides Atmospheric sync in the background |
| `repo:dev.at-intent.usage`                                     | The AT Intents discovery record written at sign-in                             |

**Optional features ask when first used.** Each is a `ScopeFeature` in `SCOPE_FEATURES`:

| Feature    | Scopes                                                     |
| ---------- | ---------------------------------------------------------- |
| `semble`   | `network.cosmik.card/collection/collectionLink/connection` |
| `margin`   | `at.margin.note/collection/collectionItem`                 |
| `linkblog` | `site.standard.publication/document`                       |
| `pckt`     | linkblog + `blog.pckt.document`                            |
| `offprint` | linkblog + `app.offprint.document.article`                 |
| `feedback` | `app.userinput.discussion/upvote` + `blob:image/*`         |

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

`backend/lexicons/app/skyreader/authFull.json` defines `app.skyreader.authFull`: repo access to
every `app.skyreader.*` collection Skyreader writes. A set can only name resources under its own
namespace (`app.skyreader.`), so other apps' lexicons stay granular.

Why bother: the consent screen shows the set's `title`/`detail` instead of one line per
collection. And **the PDS re-resolves the set on every token refresh**, so adding a new
`app.skyreader.*` collection to the set reaches live sessions without a re-auth. Refresh writes
the new scope back to `sessions.granted_scopes`. Before sets, every new collection meant the
"log in again" dance (see the comments on `READING_ROOM_SCOPES`, `AT_INTENT_SCOPES`, etc.).

### Publishing it (one-time, then on every change)

A PDS resolves `include:app.skyreader.authFull` like any lexicon: the authority `app.skyreader`
reversed is `skyreader.app`, so it reads a DNS TXT record at `_lexicon.skyreader.app`, then
fetches the `com.atproto.lexicon.schema` record with rkey `app.skyreader.authFull` from that
DID's repo.

1. Pick the account that publishes Skyreader's lexicons (the Skyreader account), and note its DID.
2. Add DNS: `_lexicon.skyreader.app  TXT  "did=<that DID>"`.
3. Publish with [goat](https://github.com/bluesky-social/goat), logged in as that account
   (`goat account login`), from `backend/`:

   ```bash
   goat lex lint lexicons/app/skyreader/authFull.json
   goat lex publish lexicons/app/skyreader/authFull.json
   ```

4. Verify: `dig TXT _lexicon.skyreader.app` returns the DID, and
   `<PDS>/xrpc/com.atproto.repo.getRecord?repo=<DID>&collection=com.atproto.lexicon.schema&rkey=app.skyreader.authFull`
   returns the schema.
5. Turn it on: set `OAUTH_PERMISSION_SETS = "true"` in `backend/wrangler.toml` (staging first,
   under `[env.staging]` `vars`), deploy, sign in, check the consent screen shows "Skyreader".

**Order matters.** A PDS refuses the whole authorization if it can't resolve an included set. So
publish before flipping the flag, and never remove a collection from the published set that
live code still writes.

Existing sessions are unaffected either way: their granular grants satisfy the same checks.

## Adding a scope

- **A new `app.skyreader.*` collection:** add it to `authFull.json` and to
  `SKYREADER_REPO_SCOPES` (`test/oauth-scopes.spec.ts` keeps the two in sync), then republish the
  set. Sessions pick it up on their next refresh. Only sessions created while
  `OAUTH_PERMISSION_SETS` was off need an upgrade, and the route's 403 handles that.
- **Another app's collection for an existing feature:** add it to that feature's list in
  `SCOPE_FEATURES` and to `ALL_POSSIBLE_SCOPES`. Sessions that lack it get a 403 with that
  feature and one "Allow access" click.
- **A new optional feature:** add a `ScopeFeature`, its entry in `SCOPE_FEATURES`, its label in
  the frontend's `SCOPE_FEATURE_LABELS`, and return `insufficientScopesResponse('<feature>')`
  from its gate.
