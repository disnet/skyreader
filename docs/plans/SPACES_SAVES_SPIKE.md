# Spike: saved articles on atproto Spaces

**Status:** spike, flag-gated off. Not a decision to ship.
**Flag:** `SPACES_SAVES_ENABLED` (`.dev.vars` only — absent from `wrangler.toml`).
**Protocol findings:** [`experiments/spaces-saves/FINDINGS.md`](../../experiments/spaces-saves/FINDINGS.md)

## Why

Skyreader's saves sit in two corners of a quadrant, and the interesting one is
empty:

|                           | Private                         | Public                           |
| ------------------------- | ------------------------------- | -------------------------------- |
| **Skyreader-only**        | D1 `saved_articles` (canonical) | —                                |
| **Portable (Atmosphere)** | **nothing — this is the gap**   | Semble / Margin external backing |

Saves live only in D1. The old `app.skyreader.feed.saved` PDS export was removed
because a public repo made every save publicly visible, which is why the copy
rules say never to claim saves live on the PDS. The one portability path today is
external backing, and it makes the whole Saved list a _public_ foreign
collection.

[atproto Spaces](https://atproto.com/blog/atproto-spaces-alpha) is non-public data
on the protocol: records in per-space permissioned repos on the author's PDS,
gated by a space authority and a membership policy. That is exactly the missing
quadrant. This spike stores saved-article records in a personal space to find out
whether it's real.

## Shape

One personal space per user, owned by the user:

- **Authority** = the user's own DID; the space is hosted on their PDS.
- **Space ref** `at://{did}/space/app.skyreader.space.saved/self` — derivable
  from the DID, so no lookup table.
- **Policy** `#memberListPolicy` (private to its owner, who is a member by
  construction) with `appAccess: #open` for the spike.
- **Records** in `app.skyreader.feed.saved` — the retired collection name, which
  inside a permissioned repo finally means what it says. **Metadata only**: the
  article body stays in D1, same content split the removed export observed.
- **rkey identical to the D1 rkey**, so the mapping between the stores is
  implicit and no migration is needed.
- **D1 stays canonical.** The space is a best-effort mirror written under
  `ctx.waitUntil`. A space failure never fails a save.

## What was built

| Piece                                                                                     | Where                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Protocol lifecycle experiment (11 checks, incl. outsider-denial and the portability read) | `experiments/spaces-saves/`                                                    |
| Record lexicon (metadata-only) + the OAuth permission set                                 | `backend/lexicons/app/skyreader/feed/saved.json`, `.../space/savedAccess.json` |
| Space refs, record mapping, DPoP, credential flow, XRPC client, transports                | `backend/src/services/spaces/`                                                 |
| Flag gate, capability probe, mirror hooks                                                 | `backend/src/services/spaces/mirror.ts`                                        |
| Dual-write on save/delete                                                                 | `backend/src/routes/saved.ts`                                                  |
| Dev read-back diff                                                                        | `GET /api/dev/spaces/saved-diff` (`backend/src/routes/dev-spaces.ts`)          |
| Tests                                                                                     | `backend/test/spaces-{record,protocol,mirror}.spec.ts`                         |

The backend takes no `@atproto/*` dependency: the alpha SDK assumes Node, and the
Worker already hand-rolls its XRPC. The Node experiment imports the _same_
modules, so Phase 0 exercises the code Phases 1–3 ship rather than a parallel
implementation.

## What the alpha turned out to be

Three findings changed the plan (details and citations in FINDINGS.md):

1. **Writing to your own repo in a space needs no space credential** — plain
   session auth against your own PDS. So the mirror is an ordinary authenticated
   XRPC POST. The credential flow (delegation → credential → DPoP, 2 round trips,
   2h reusable credential) is needed only for reading a space from somewhere that
   isn't the author's session — which is precisely the portability proof.
2. **There is no `space:` OAuth scope.** Access is requested as
   `include:<nsid>` naming a **permission-set lexicon**. Ours is committed as
   `app.skyreader.space.savedAccess`, and is deliberately _not_ requested by the
   live OAuth flow.
3. **`createSpace` takes no member list** — policy and app access only, membership
   afterwards. A personal space needs no `addMember` call.

## Demo checklist

Start from an account with **backing off** (a backed save skips the mirror by
design, so the space would look broken).

1. Run a spaces PDS: `docker run -p 2583:2583 ghcr.io/bluesky-social/atproto:pds-spaces-alpha`.
2. `cd experiments/spaces-saves && SPACES_PDS_URL=http://localhost:2583 npm run lifecycle`
   — 11/11 is the gate. If the outsider is _not_ denied, stop the spike.
3. Add `SPACES_SAVES_ENABLED=true` to `backend/.dev.vars`, point a session at the
   spaces PDS, and `./scripts/dev-local.sh`.
4. Save an article in the reader; delete another.
5. `GET /api/dev/spaces/saved-diff` → `inSync: true`.
6. Read the same record back with the Phase 0 script's credential path — a second
   client, its own credentials, the same data. That is the portability claim,
   demonstrated outside Skyreader.

## Recommendation

**(c) too early to ship — revisit at beta, and revisit as option (a).**

The protocol fits the gap better than expected, and the integration cost is lower
than the plan assumed: writes are ordinary session-authed XRPC, records map to D1
rows one-to-one, and the whole path is one env var wide. Nothing about the design
argues against it.

Everything blocking is operational:

- **No user can use it.** No production PDS implements Spaces. Until PDS coverage
  is real, a user-facing "private Atmospheric backup" toggle would be a switch
  that fails for every account.
- **Alpha terms forbid it.** Weekly breaking changes, no backups, destructive
  migrations, the sandbox is deleted at the end of the alpha, production use
  explicitly prohibited.
- **Best-effort mirroring drifts.** Acceptable for a spike because D1 is canonical
  and `saved-diff` makes drift visible; a ship needs a reconciliation job (cf.
  `RETENTION_SYNC_PLAN.md`) and a backfill of existing saves.

When it does land, it should land as **(a) a third backing option — "private
Atmospheric backup" — alongside Semble and Margin**, not as (b) the canonical
store. Backing is already the concept "your saves also live somewhere portable";
Spaces adds the private variant of it, and the settings surface, the enable/
disable flow, and the user's mental model all exist. Making the space canonical
would mean betting the Saved list on an alpha protocol for no reader-visible gain.

Before any user-facing ship:

- request `include:app.skyreader.space.savedAccess` in `config/scopes.ts` and the
  client metadata — kept out of `GRANULAR_SCOPES` so it doesn't force existing
  users through re-auth, and checked against the scope-string reconstruction on
  the refresh path;
- switch `appAccess` from `#open` to `#allowList` pinned to Skyreader's
  `client_id` per environment;
- a reconciliation job plus a backfill of existing saves;
- decide the interaction with external backing (both on at once?);
- and update the CLAUDE.md copy rule. Today "saves never live on the PDS" is
  exactly true. A shipped space mirror makes saves live in a _permissioned_ repo
  on the PDS — still not public, still not the public repo the old export used.
  The copy would need to say that precisely, or it will read as the thing we
  removed.
