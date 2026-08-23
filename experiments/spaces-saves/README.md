# experiments/spaces-saves

Phase 0 of the atproto Spaces saved-articles spike: the protocol lifecycle in
isolation, before any of it is trusted by the app. Findings live in
[FINDINGS.md](FINDINGS.md); the product decision lives in
[`docs/plans/SPACES_SAVES_SPIKE.md`](../../docs/plans/SPACES_SAVES_SPIKE.md).

## Run it

```bash
cd experiments/spaces-saves

# Against a real spaces-capable PDS (this is the run that produces findings)
SPACES_PDS_URL=http://localhost:2583 npm run lifecycle

# Harness self-test against an in-process fake — no PDS, no network
npm run lifecycle:fake
```

To get a real PDS, either:

- run `docker run -p 2583:2583 ghcr.io/bluesky-social/atproto:pds-spaces-alpha`
  (pin the digest and record it in FINDINGS.md), or
- get an invite from your BPS account for the hosted alpha PDS and pass
  `SPACES_PDS_URL=<alpha pds> SPACES_INVITE_CODE=<code>`.

The script creates two throwaway accounts (an owner and an outsider), so point it
only at a sandbox.

## What it checks

11 checks, in three groups. The two that decide the spike:

- **privacy** — the outsider is denied both a direct read and a space credential.
  If either succeeds, the "private and portable" claim is false and the spike
  should stop.
- **portability** — a client holding nothing but a minted credential (no session,
  no cookie) reads the saved record back out of the space.

The rest cover create → get → list → delete and the credential round-trip cost.

## No SDK

The script imports the backend's own modules under
`backend/src/services/spaces/` rather than `@atproto/*@alpha`. The backend runs
on Workers and can't take the alpha SDK (it assumes Node), so the wire code has
to be hand-rolled regardless — and a Phase 0 that exercises different code from
Phases 1–3 would prove nothing about them. `ts-resolve.mjs` is the small hook
that lets Node import those extensionless TypeScript imports directly.

Node ≥ 22.18 (type stripping on by default). Node prints a
`MODULE_TYPELESS_PACKAGE_JSON` warning for the backend sources — harmless.

## `--fake` is a harness test, not a protocol result

`fake-pds.mjs` is our own reading of the alpha's behaviour. It verifies real
ES256 DPoP proofs (including the `cnf.jkt` binding and the "no `ath` when
obtaining a credential" rule) and enforces the member list, so a green run means
the client code, the credential flow, and the script's assertions all work. It
says nothing about what the real implementation does. Never quote a `--fake` run
as a finding.
