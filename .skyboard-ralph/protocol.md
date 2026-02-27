# Skyboard Loop Agent

This project uses a Skyboard kanban board to drive an iterative development loop. Each invocation performs exactly one card transition: check the board, pick one card, advance it to the next column, and exit.

## Board

- Board DID: `{{boardDid}}`
- Board rkey: `{{boardRkey}}`
- Board flag: `--board {{boardDid}}:{{boardRkey}}` (pass this on every `sb` command)

## Columns (workflow stages)

1. **Backlog** — Raw ideas or requests. Not yet scoped.
2. **Planned** — Scoped and ready to implement. Has clear acceptance criteria.
3. **In Progress** — Actively being worked on.
4. **In Review** — Implementation complete, needs verification (tests pass, code review).
5. **Done** — Verified and complete.

## Agent Protocol (one invocation = one transition)

This is iteration {{iteration}} of {{maxIterations}}.

Each invocation of the loop, follow this protocol:

### 1. ASSESS

Run `sb cards --json --board {{boardDid}}:{{boardRkey}}` to see the full board state. Identify which cards are in which columns and which have the `blocked` label.

### 2. PICK

Select exactly one card to work on. You will only work on this single card during this invocation. Use this priority order:

- **In Progress** cards first — continue/finish implementation, then move to In Review
- **Backlog** cards — scope and plan the work, then move to Planned

**Note:** The human reviews cards in **Planned** and **In Review** and moves them to the next column. Do not work on cards in those columns.

**Skip cards with the `blocked` label.** These are waiting on human input. However, if a previously-blocked card has a new comment from the human since it was blocked, the human has likely answered — remove the `blocked` label (`sb edit <ref> -l "" --board {{boardDid}}:{{boardRkey}}`) and work on it.

Within a column, pick the topmost (first listed) non-blocked card. Use `sb show <ref> --json --board {{boardDid}}:{{boardRkey}}` to read the card's full details and comments before starting.

### 3. DO one transition

Each transition type has a specific definition of done:

| Transition | What to do | Move when |
|---|---|---|
| Backlog → Planned | Checkout `main` and pull latest changes (`git checkout main && git pull`). Read the card. Break down the work. Add a comment with implementation approach and acceptance criteria. | Scope is clear and actionable |
| In Progress → In Review | Fetch latest from origin/main (`git fetch origin main`). Create or checkout the card branch from `origin/main` (see Branching rules below). Implement the feature. Run tests. Push the branch and create a PR with `gh pr create`. | Code is complete, tests pass, and PR is created |

**Human-owned transitions (do not perform these):**

| Transition | Owner |
|---|---|
| Planned → In Progress | Human reviews the plan and moves card when approved |
| In Review → Done | Human reviews the implementation and moves card when verified |

**Never skip columns.** A card must pass through each stage in order.

**Moving backwards:** If verification fails during a review stage, move the card back to the previous stage with a comment explaining what failed.

**IMPORTANT: After completing one transition, proceed immediately to UPDATE (step 4) and then WRITE STATUS AND EXIT (step 5). Do not pick another card or perform additional transitions.**

### 4. UPDATE

After doing the work:

1. Add a comment to the card describing what you did: `sb comment <ref> "<summary>" --board {{boardDid}}:{{boardRkey}}`
2. Move the card: `sb mv <ref> <column> --board {{boardDid}}:{{boardRkey}}`

### 5. WRITE STATUS AND EXIT

After completing one transition (or determining you can't make progress), write a status file and stop.

**After a successful transition:**

```bash
echo "CONTINUE" > .skyboard-ralph/loop-status
```

**If blocked on a card:**

1. Comment on the card explaining what's blocking you
2. Add the `blocked` label: `sb edit <ref> -l blocked --board {{boardDid}}:{{boardRkey}}`
3. Do NOT move the card
4. Try to pick a different non-blocked card instead
5. If no other non-blocked cards are available:

```bash
echo "BLOCKED" > .skyboard-ralph/loop-status
```

**If all done** (every card is in Done and Backlog is empty):

```bash
echo "DONE" > .skyboard-ralph/loop-status
```

**If all remaining cards are blocked** (every non-Done card has the `blocked` label):

```bash
echo "BLOCKED" > .skyboard-ralph/loop-status
```

You MUST write to `.skyboard-ralph/loop-status` before exiting. The outer loop script reads this file to decide whether to continue.

## Rules

- One card, one transition per invocation. Do not work on multiple cards.
- Always read the card details (`sb show`) before starting work.
- Always comment before moving. The comment trail is how the human tracks progress.
- Check for new comments from the human — they may have added guidance or reprioritized.
- If a card's description is vague, comment asking for clarification and move on to the next card.
- **Branching:** Always create or checkout a dedicated branch for the card you are working on before making any code changes. The branch name must be `card/<rkey>` where `<rkey>` is the card's record key (e.g., `card/3lgjasx2zws2p`). Always fetch first (`git fetch origin main`) and branch off of `origin/main` (i.e., `git checkout -b card/<rkey> origin/main`). If the branch already exists, check it out and rebase onto `origin/main`.
- **Pushing:** Only push when creating a PR via `gh pr create` for the In Progress → In Review transition. Do not force-push.
- Commit code changes with clear commit messages before ending the iteration.
- Always write `.skyboard-ralph/loop-status` as your very last action.
