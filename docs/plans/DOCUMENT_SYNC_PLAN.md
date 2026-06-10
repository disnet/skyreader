# Document Sync: Per-Scope Digest Short-Circuit (304-style, no new store)

> Extends `RETENTION_SYNC_PLAN.md`, which put **feeds** on a durable item log + monotonic cursor and
> deliberately left **documents** (`atproto.documents` / `site.standard.document`) on a phase-1
> "contract-shape only" treatment: emit `cursor`/`generation`/`hasMore` but keep them inert
> (`cursor:0`, `hasMore:false`) and re-download the full per-author set every poll. This plan
> supersedes that document section.
>
> Unlike feeds, documents do **not** get a durable item log. The PDS is a lossless durable source, so
> retention is a non-goal, and the per-author `document_cache` blob the proxy already keeps is the
> authoritative current set. This plan eliminates the per-poll re-download with a **per-scope content
> digest**: the proxy hashes the blob, the client echoes the last hash it saw, and a match returns a
> bodyless `status:'unchanged'` response. No second store, no seq counter, no tombstones, no firehose changes, and
> — crucially — **no change to how the client applies a result**: on a digest miss it keeps today's
> proven full-replace reconcile.

## The problem (and what it is *not*)

The pain is payload, not correctness: documents are **re-downloaded in full every poll**. The
frontend's `reconcileDocuments` (`documentSync.ts:52`) full-replaces each scope every poll, and the
proxy serves the whole per-author set each time. This is the symptom you see as "documents repeatedly
sent back in `/batch`."

Two facts shape the fix:

1. **The blob is already the authoritative set.** `document_cache` is a per-author blob, capped at
   `MAX_DOCUMENTS_PER_AUTHOR = 100`, kept fresh by both the full fetch (`fetchAndCacheDocuments`,
   `app.ts:1203`) and the firehose splice (`spliceDocument`/`removeDocument`, `jetstream.ts:239`/`:263`).
   It already knows the exact current set.
2. **Documents change rarely.** The product is calm and reading-first (PRODUCT.md); a subscribed
   author publishes or edits infrequently. So for the overwhelming majority of polls, the
   authoritative set is **byte-for-byte what the client already holds**. The dominant cost today is
   re-shipping an unchanged ≤100-doc blob over and over.

That second fact is the whole opportunity. The cheapest correct sync is one that says "nothing
changed" almost every time and ships the full (small, bounded) set only when something did. A
per-scope **digest** does exactly that.

### The digest

For one scope (`did` + optional `siteUri`), the digest is a cheap hash over the scoped blob's
**sorted `(recordUri, recordCid)` pairs**:

```
digestScope(B):                       # B = filterByPublication(blob, siteUri)
  pairs = sorted((d.recordUri, d.recordCid) for d in B)
  return hash(join(pairs))            # e.g. SHA-256 hex, or any stable cheap hash
```

`recordCid` changes on every edit and `recordUri` identifies the doc, so this single value captures
**every** new, edited, and deleted document in the scope:

- a **new** doc adds a pair → digest changes;
- an **edited** doc changes a `recordCid` → digest changes;
- a **deleted** doc (or cap-evicted doc) removes a pair → digest changes;
- an **unchanged** scope → identical sorted pairs → identical digest.

No per-document diff, no deletes list, no `op` codes. One hash per scope is the entire wire delta.

### Why not a server-side seq log (the rejected alternative)

A `feed_items`-style durable log with a monotonic seq cursor (one option considered) would build
edit-aware delivery on the server. But documents differ from RSS in every dimension that justifies a
log: the source is lossless (no retention to compensate for), sets are tiny (≤100/author), documents
are **mutable** (a seq cursor must bump seq on edit, the delete-and-reinsert problem), and deletes are
**real and must propagate**. A seq log handles edits only by decoupling delivery-seq from
display-`published_at`, handles deletes only via a periodic full reconcile (hours-late), and needs a
second store kept transactionally consistent with the blob across two write paths (fetch + firehose).
The digest gets edits *and* deletes for free from the blob the proxy already maintains, with none of
that machinery. See `RETENTION_SYNC_PLAN.md §Documents` for the original contract-only framing this
replaces.

### Why not a per-document manifest diff (the considered, deferred alternative)

A richer design was considered: the client uploads a `(recordUri, recordCid)` **manifest**, the proxy
diffs it against the blob, and the response carries only the new/edited docs plus a `deletes` list,
which the client applies **in place** (apply-delta). This is more *elegant* — on a changed poll it
ships only the one doc that changed rather than the whole ≤100 set — but it is the wrong **first**
move here:

- **It only wins in a narrow case.** It beats the digest only when an author holds *near 100 docs*
  **and** changes them often enough that re-shipping the bounded set to deliver one change is the
  bottleneck. For a calm, rarely-changing reading product, that case is rare.
- **It adds real failure surface.** Apply-delta replaces the proven full-replace reconcile with
  insert/merge/remove logic; deletes are *derived* (present in manifest, absent from blob), so a
  **mis-scoped manifest mass-deletes** (see the scoping footgun under *Phase 2*). The digest reuses
  today's full-replace path untouched, so a digest miss can never corrupt state.
- **It needs the client to persist `recordCid`** (it currently does not — see *Schema reality*),
  whereas the digest keeps the cid entirely server-side.

So: **ship the digest first** (most of the payload win, near-zero risk), and treat the manifest diff
as a **Phase 2 gated on evidence** — only build it if instrumentation shows changed polls routinely
re-ship a near-cap blob. The full plan for it is preserved at the end.

## Primary goal

**An unchanged scope returns an empty response; a changed scope returns the full current set, applied
exactly as today.** Concretely, per poll per scope:

- **unchanged** (client's `since_digest` equals the proxy's current digest) → `{ status:'unchanged' }`
  — a bodyless result: no `documents`, no `digest` (the client already holds the digest it sent). The
  client keeps everything it holds for that scope, touches nothing. `unchanged` is a **distinct
  status**, not a flag on `ready`, so the client's existing `status === 'ready'` apply filter excludes
  it for free — an empty-bodied `ready` can never reach the reconcile and clear a scope (see *Why a
  distinct status*).
- **changed** (digest differs, or client sent no digest) → the full scoped blob in `documents`, plus
  the new digest to store. The client runs today's `reconcileDocuments` full-replace for that scope:
  new docs inserted, edited docs merged in place (read state survives — see *Edit semantics*),
  vanished docs dropped. **No new client apply logic.**

Cold start (no stored digest) is just the "changed" branch: send no `since_digest`, get the full set,
store the returned digest. No special case.

### Edit semantics (decided, unchanged from prior plans)

When a document is edited upstream: **update in place, keep read state, no reorder.** Read/labels are
keyed by `recordUri` in `item_labels_cache` and survive a full-replace reconcile automatically
(reconcile re-keys by `recordUri`); the client sorts by `publishedAt`, which an edit recomputes to the
same value, so the doc keeps its slot. This is the quiet, reading-first behavior (PRODUCT.md) — edits
don't nag. (Reversible later: "resurface edited docs as unread" or an "edited" badge is purely how the
client *applies* a changed row — the wire contract is unaffected.)

### Non-goals / deliberate limits

- **No retention / >cap catch-up.** A scope serves the current live slice (≤ `MAX_DOCUMENTS_PER_AUTHOR`).
  The PDS is the durable source; we don't synthesize history.
- **Cap-eviction looks like a delete.** A doc pushed out of the top-100 window (a newer doc displaced
  it) leaves the blob, so its pair leaves the digest; the next changed response omits it and the
  full-replace reconcile drops it — indistinguishable from a real upstream delete. This exactly
  matches today's full-replace behavior and suits the live-window product. Documented, not a
  regression.
- **No reordering on edit.** An edit updates content only; `publishedAt` is stable, so the document
  keeps its timeline slot.
- **No per-doc delta in Phase 1.** A changed scope re-ships its whole (bounded) set. That is today's
  behavior, made conditional. Phase 2 (manifest diff) narrows it if profiling demands.

---

## Architecture

The per-author `document_cache` blob **stays the single source of truth** and keeps its existing
freshness/backoff bookkeeping (`fetched_at`, `last_requested_at`, `error_count`, `next_retry_at`)
exactly as today. **Nothing new is stored on the server.** The change is: compute a digest at read
time, compare it to the one the client sends, and skip the body on a match.

- **No new table.** No `document_items`, no seq counter, no generation coupling.
- **No firehose changes.** `spliceDocument`/`removeDocument` keep the blob current (`jetstream.ts`);
  the digest is computed over whatever the blob currently holds. A firehose write between two polls
  changes the digest, so the next poll sees a miss and refetches the scope.
- **No tombstones.** A delete drops a pair from the digest; the changed response omits the doc; the
  full-replace reconcile removes it. Derived, never recorded.

### The authoritativeness gate (the one subtlety)

A digest, and the full set behind a miss, are only meaningful when the blob is the **true** current
set. The danger is a **missing or never-backfilled blob** (author aged out, fresh DB, cold author): an
empty/absent blob has an empty-set digest, and serving its full-replace would wipe the client's
real holdings. Guard it:

- The read path already ensures the blob via `fetchAndCacheDocuments` (backfills when missing/stale).
  If that yields an authoritative set (fetch succeeded, or a real cached blob exists) → compute the
  digest and return `status:'unchanged'` or `status:'ready'` normally.
- If the blob cannot be made authoritative (fetch errored with no usable prior blob): **do not** emit
  `status:'unchanged'` and **do not** serve a full-replace from an unknown set — return
  `status:'error'` exactly as today (`app.ts:2049-2062`), so the client keeps what it holds and
  retries. Never let an empty blob masquerade as "this scope is now empty." (Authoritativeness is now
  carried entirely by `error` vs. `ready`/`unchanged`; there is no separate `complete` flag.)

A *stale-but-successful* blob (last fetch errored but a real prior blob exists) is still authoritative:
it was the real set at `fetched_at`; its digest is correct for that set, and any change since is caught
on the next successful refresh. This matches today's behavior — the endpoint already serves the prior
blob in that case (`app.ts:2030-2041`).

This gate is *always on* (every authoritative poll either confirms-unchanged or refreshes), so the
client converges to the true set continuously — no periodic full reconcile needed.

### Why there is no cold-start race

There is **no cursor and no high-water mark**. The client stores only an opaque digest per scope. Each
poll the proxy recomputes the digest from the *current* blob (one `SELECT`) and compares. A firehose
write that lands after a given digest computation simply changes the next computation, producing a
miss on the next poll. There is no token a client can advance past unseen content. Correctness needs
only that the blob read is a consistent snapshot, which a single `SELECT` is.

### Per-author cap, firehose, cleanup = unchanged

`MAX_DOCUMENTS_PER_AUTHOR = 100` stays a pure cache/display bound. `spliceDocument`/`removeDocument`
keep doing exactly what they do today (`jetstream.ts:239`/`:263`), including their early-return when no
blob row exists. `cleanupCache` (`app.ts:2244`) evicting an idle author's row just means the next poll
backfills and serves a cold-start (full) response — the client stored digest no longer matches the
fresh blob's, so it's a normal miss.

---

## Read path

One path, parameterized by whether the request carries a `since_digest` for the scope:

```
ensure authoritative blob (fetchAndCacheDocuments)         # existing backfill/freshness logic
if blob not authoritative:
    return { status:'error', ... }                         # existing error branch, unchanged
B      = filterByPublication(blob, siteUri)                # existing scoping, standard-site.ts:328
digest = digestScope(B)                                    # cheap hash over sorted (uri, cid)
if entry.since_digest == digest:
    return { status:'unchanged' }                          # bodyless; client already holds the digest
return   { status:'ready', documents:B, digest }           # miss → full scoped set + new digest to store
```

- An **absent** `since_digest` (cold start / first sync for the scope) never matches, so the scope is
  served full and the client stores the returned `digest`. No branch.
- `documents` carries full `ProxyDocument`s on a miss (so the backend read-annotation join, keyed on
  `recordUri`/`item_type='document'`, is unaffected). A `status:'unchanged'` result carries no
  `documents` at all, so there is nothing to annotate and nothing to apply.

The endpoint stops emitting the inert phase-1 `cursor:0`/`generation`/`hasMore:false` placeholders
(`app.ts:1969-1988`/`:2078`):

- **No `cursor`.** The digest is the freshness token; there is no server seq.
- **No `generation`.** The digest is self-correcting — a DB wipe empties the blob, the
  authoritativeness gate returns `status:'error'` rather than a spurious empty set, and once the
  refetch repopulates, the client's stored digest mismatches and it refreshes. No wipe-detection token
  is needed.
- **No `hasMore` / drain loop.** A scope's authoritative set is ≤100 docs and ships in one response.
  There is no backlog to drain — simpler than feeds, which genuinely page.

### `since_uris` compat

The legacy `since_uris` path (`filterSinceUris`, `standard-site.ts:342`) is already a **no-op** — the
current client sends no `since_uris` and full-replaces every poll. Keep it accepted-but-ignored during
rollout so an un-upgraded client (which sends neither `since_digest` nor `since_uris`) still gets the
full blob and works exactly as today. Retire it once every client sends `since_digest`.

---

## Response shape

Each document scope result becomes (replacing the inert phase-1 `cursor:0`/`generation`/`hasMore:false`).
`status` now has **three** values — `ready`, `unchanged`, `error` — and the body depends on it:

- **`status:'ready'`** (digest miss / cold start): carries `documents` (the full scoped
  `ProxyDocument`s) **and** `digest` (the per-scope content hash). The client applies the full-replace
  and stores the `digest` to send as `since_digest` next poll.
- **`status:'unchanged'`** (`since_digest` matched): **bodyless** — no `documents`, no `digest`. The
  client already holds the current set and the digest it sent; it applies nothing and keeps its stored
  digest.
- **`status:'error'`** (non-authoritative blob): the existing branch, unchanged. The client keeps what
  it holds and retries.

There is **no `unchanged` boolean** (it is a `status`, not a flag — see *Why a distinct status*), and
**no `complete` field** for documents: authoritativeness is now expressed entirely by `error` vs.
`ready`/`unchanged`, so a separate `complete` carries no information and is dropped. There is also **no
`op` field, no per-item seq, and no `deletes` list** — deletes are absorbed by the full-replace on a
miss, signalled only by the digest changing.

### Why a distinct status (not an `unchanged:true` flag)

Modeling "nothing changed" as `{ status:'ready', unchanged:true, documents:[] }` is a footgun: the
client's reconcile keys off `status === 'ready'`, so an empty-bodied `ready` would pass the apply
filter and **clear the scope** (the reconcile drops a scope's docs before adding the fresh set — with
an empty set, it just drops). Guarding that requires remembering to also test `!unchanged` everywhere
the filter appears. Making `unchanged` a separate `status` makes the bad state **non-representable**:
the existing `status === 'ready'` filter excludes it automatically, the backend's read-annotation join
sees no URIs to stamp, and there is no flag to forget. Same wire savings, zero apply-path risk.

---

## Schema reality (read before estimating frontend work)

`SocialDocument` (`frontend/src/lib/types/index.ts:505`) does **not** carry `recordCid`, and the
client never stores it. **The digest design needs neither** — the cid lives entirely server-side
inside `digestScope`; the client only stores an opaque per-scope digest string. So **no
`SocialDocument` change and no Dexie version bump** are required for Phase 1. (This is a concrete
advantage over the manifest diff, which *would* need the client to persist `recordCid`.)

The client just needs somewhere to keep `{ scopeKey → digest }`. Options, cheapest first:

- **In-memory + localStorage** keyed by `scopeKey = did + '|' + (siteUri ?? '')`. Survives reloads,
  trivial, no Dexie touch. A lost digest map just causes one cold-start full fetch — harmless.
- A tiny Dexie `documentDigests` table if persistence-with-the-rest-of-the-DB is preferred (version
  bump 35 → 36, add to `clearAllData()`). Only do this if localStorage feels wrong; functionally
  identical.

Default to localStorage — losing it is self-healing, so it doesn't warrant a schema migration.

---

## Implementation

Three surfaces. **Keep the full-blob path working throughout** (it is the no-`since_digest` cold-start
path and the un-upgraded-client compat path) until every client sends a digest.

### 1. feed-proxy (`feed-proxy/src/app.ts`, `standard-site.ts`) — the work, and it's small

- **No schema change.** No `document_items`, no `document_seq`. (`document_cache` and the firehose are
  untouched.)
- **Digest helper.** Add `digestScope(scopedBlob): string` (`standard-site.ts`, beside
  `filterByPublication`): sort `(recordUri, recordCid)` pairs, hash. Pure function, unit-testable in
  isolation. Use a cheap stable hash (SHA-256 hex over the joined pairs is fine; the input is ≤100
  short strings).
- **Read path.** In the `/documents` batch endpoint (`app.ts:1944-2086`), after `filterByPublication`
  compute `digest = digestScope(scoped)`; if `entry.since_digest === digest` return the bodyless
  `{ status:'unchanged' }`; else return `{ status:'ready', documents:scoped, digest }`. Drop the
  `cursor:0`/`generation`/`hasMore:false`/`complete` fields. Keep the existing `status:'error'` branch
  (`:2049-2062`) for a non-authoritative blob — never short-circuit or serve an empty set from one.
- **`recordCid` stable across refetch (the one correctness dependency).** The load-bearing property is
  not merely that the cid is *non-empty* — it is that the cid is **identical for byte-identical content
  across a refetch**, so a no-op refresh produces the same digest. CIDs are content-addressed over
  deterministic DAG-CBOR, so this holds as long as the cid that lands in the blob comes straight from
  the record's own cid on **both** paths — `listRecords` (`recordToProxyDocument`) and firehose
  (`applyDocumentEvent`, `jetstream.ts:226`) — and is never recomputed with a non-canonical encoding.
  If the cid ever varies across refetch for unchanged content, the digest flips every poll: **no
  correctness bug, but the entire payload win silently evaporates** (every poll becomes a miss). Two
  failure shapes to rule out: an empty/constant cid (edits become invisible — the hash doesn't move)
  *and* an unstable cid (everything becomes a perpetual miss).
- **Firehose / cleanup.** **No changes.** The blob they maintain is what the digest reads.
- **Tests** (`integration.test.ts`):
  - **Unchanged:** second request with the prior `digest` → `status:'unchanged'`, no `documents` field.
  - **Stable across refetch (guards the value prop):** force a *refetch* of the blob with **no upstream
    change** (bypass the freshness window so `fetchAndCacheDocuments` re-pulls and rewrites the blob) →
    the recomputed digest is **identical** → still `status:'unchanged'`. This is distinct from the
    plain Unchanged test, which exercises only the no-refetch cache hit; this one catches a `recordCid`
    that is unstable across an actual refetch (which would silently turn every poll into a miss).
  - **Edit:** a doc whose `recordCid` changed → digest differs → `status:'ready'` with the full scoped
    set; the edited doc's `publishedAt` is unchanged (client keeps slot).
  - **New:** a new `recordUri` → digest differs → full set returned.
  - **Delete:** a removed `recordUri` (test both firehose-`removeDocument` and refetch-dropped) →
    digest differs → full set returned without it.
  - **Cold start:** no `since_digest` → full set + a `digest`.
  - **Cap-eviction:** a doc displaced past `MAX_DOCUMENTS_PER_AUTHOR` changes the digest and is absent
    from the next full set (documented behavior).
  - **Authoritativeness gate:** missing/un-backfillable blob → `status:'error'`, never `status:'unchanged'`
    and never an empty full-replace.
  - **Publication scope:** the digest is per-`siteUri`; a change in publication Q does not flip
    publication P's digest (no cross-scope leakage).
  - **Compat:** a request with neither `since_digest` nor `since_uris` still serves the full scoped
    blob.

### 2. backend (`backend/src/`) — passthrough, mechanical

- `routes/feeds-v2.ts` `handleV2BatchDocumentFetch` (`:336`): thread `since_digest` through the
  per-author request body; pass `status`/`documents`/`digest` through. The read-annotation join
  (`item_type='document'`, keyed on `recordUri`, `:418`) applies to `documents` on a `ready` result as
  today; a `status:'unchanged'` result has no documents and is passed through untouched. Drop the dead
  `cursor`/`generation`/`complete` threading for documents.
- `services/feed-proxy-client.ts` `fetchDocumentsBatch` (`:408`): forward `since_digest`; surface the
  three-valued `status` (`ready`|`unchanged`|`error`) and `digest` on `ProxyDocumentEntry` (`:96` —
  add `digest`; widen `status`; **drop `complete`**).
- `types.ts`: extend the document request type with `since_digest`; the result type with `digest` and
  the `unchanged` status. Drop `since_seq`/`cursor`/`generation`/`complete` for documents.

### 3. frontend (`frontend/src/lib/`) — send a digest, skip on unchanged

- **No Dexie change** (digests in localStorage; see *Schema reality*).
- **`documentSync.ts`:**
  - `buildDocumentRequests` (`:78`): attach `since_digest` per scope from the stored
    `{ scopeKey → digest }` map (absent on first-ever sync → cold start).
  - In the apply step, **keep `reconcileDocuments` exactly as is** (`:52`). Because `unchanged` is a
    distinct `status` (not a flag on `ready`), the existing `status === 'ready'` filter already excludes
    it — **no new guard is needed**, and an empty-bodied result can never reach the drop-then-add loop
    (`documentSync.ts:60-65`) and clear a scope. The only added logic: after applying a `ready` result,
    store its `digest` for that scope; `unchanged` and `error` results are simply not applied (as today
    for `error`).
- **`feedFetcher.ts`:** documents stay a single-shot per scope (no `hasMore`, no drain loop). Feeds
  keep their drain loop unchanged.
- Retire `since_uris` handling once nothing sends it.

---

## Rollout order

1. **Proxy:** add `digestScope`, compute + compare in `/documents`, emit `status:'unchanged'` on a
   match and `status:'ready'` + `digest` on a miss. No client impact — a client sending no
   `since_digest` always misses and gets the full blob, exactly today.
2. **Backend** passthrough (`since_digest` in; `status`/`digest` out).
3. **Frontend:** store + send the per-scope digest; skip `unchanged` results (the existing
   `status === 'ready'` filter does this for free); keep full-replace on a miss.
4. After a release cycle with no no-digest traffic, retire the `since_uris`/unconditional-full path
   from all three surfaces.

## Open questions / decisions

- **`recordCid` stable across refetch.** The one correctness dependency: the cid must be non-empty
  **and identical for unchanged content across a refetch** on both the `listRecords` and firehose
  paths (`jetstream.ts:226`). A constant/empty cid makes edits invisible to the digest; an *unstable*
  cid turns every poll into a miss and silently voids the payload win. Covered by the
  *Stable across refetch* integration test.
- **Digest storage.** Decided: localStorage `{ scopeKey → digest }`, `scopeKey = did|siteUri`. Losing
  it is self-healing (one cold fetch). Use a Dexie table only if co-locating with the rest of the DB
  is preferred (then bump 35 → 36, update `clearAllData()`).
- **Hash choice.** SHA-256 hex over sorted joined `(uri, cid)` pairs. Input is ≤100 short strings;
  cost is negligible. Any stable hash works — it never leaves the system, so it's not a compatibility
  surface.
- **Cap-eviction as a change.** Decided: acceptable, matches current full-replace behavior, suits the
  live-window product.
- **Error UX.** A non-authoritative blob returns `status:'error'` (existing path); the client keeps
  what it holds and retries silently next poll (calm default). Decide whether to surface anything
  (probably not). Note the old `complete` flag is dropped — authoritativeness is now `error` vs.
  `ready`/`unchanged`.
- **Edit application.** Decided: update in place, keep read state, no reorder (`publishedAt` stable).
  Reversible to "resurface as unread" or an "edited" badge — client-side only, wire contract
  unchanged.
- **When to escalate to Phase 2 (manifest diff).** Instrument: on a digest *miss*, how many documents
  actually changed vs. how many were re-shipped? If misses routinely re-ship a near-cap blob to
  deliver one change, build Phase 2. Until that shows up, the digest is the better cost/risk trade.

---

## Appendix: Phase 2 — per-document manifest diff (deferred, build only if profiling demands)

> This is the richer design, preserved in full. It narrows a changed-scope response from "the whole
> bounded set" to "only the docs that changed + a `deletes` list," applied **in place**. Build it
> **only** if the Phase 1 instrumentation shows changed polls routinely re-ship a near-cap blob — the
> common case (calm, rarely-changing authors) does not. It is strictly more code and more failure
> surface than the digest; the digest already captures the bulk of the payload win.

### The diff (read time)

The client uploads a `manifest` (a `Map<recordUri, recordCid>` of what it holds **for that scope**).
For one scope, given the scoped blob `B` and manifest `M`:

```
diffScope(B, M):
  newOrEdited = []
  for doc in B:
    m = M.get(doc.recordUri)
    if m is undefined:            # not held by client → NEW
      newOrEdited.push(doc)
    elif m != doc.recordCid:      # held, cid changed → EDITED
      newOrEdited.push(doc)
    # else: held, cid equal → UNCHANGED → omit
  blobUris = set(doc.recordUri for doc in B)
  deletes = [uri for uri in M.keys() if uri not in blobUris]   # held but gone → DELETED
  return { documents: newOrEdited, deletes }
```

The response carries `documents` (new + edited full records) and `deletes` (bare `recordUri`s); the
client inserts/merges the former (keeping read state + slot, `publishedAt` stable) and removes the
latter. The authoritativeness gate is identical to Phase 1: on a non-authoritative blob, serve
`documents` only and force `deletes: []` (`complete:false`) — **never** mass-delete from an unknown
set.

### The scoping footgun (why this is riskier than the digest)

`deletes` is *derived* as "in manifest, absent from blob." The scoped blob is
`filterByPublication(blob, siteUri)` — only that publication's docs. Therefore **the manifest must be
scoped to the same `siteUri`.** If a client builds one *global* manifest of all held docs and sends it
on a publication-scoped request, every other publication's doc is "in manifest, absent from this
blob" → reported as a delete → **mass eviction.** This is the failure mode the digest cannot have
(its miss path is the proven full-replace, which corrupts nothing). If Phase 2 is built, the per-scope
manifest is a hard invariant with a dedicated test, and the safety argument rests on `siteUri` being
**immutable** (a doc never migrates scopes, so any scope that legitimately holds it agrees on its
deletion).

### Migration note

`SocialDocument` does not store `recordCid` today (`types/index.ts:505`). Phase 2 requires persisting
it. On the first poll after that ships, existing rows have `recordCid: undefined`; `JSON.stringify`
drops undefined, so those URIs vanish from the manifest and the proxy reports every held doc as
`new` — one full resend per scope, self-healing on the next poll. Benign, but expected.

### Phase 2 cost summary

Relative to Phase 1 (digest), Phase 2 adds: a `diffScope` helper, a `deletes` wire field, an
apply-delta path on the client (replacing the reuse of full-replace), client-side `recordCid`
persistence (Dexie 35 → 36), the per-scope-manifest invariant + test, and the one-time migration
resend. It buys: a smaller *changed-poll* response. Worth it only when changed polls are both frequent
and near-cap — measure before building.
