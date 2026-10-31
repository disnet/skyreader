// Does a feed URL look like one only its reader should hold (a member-only
// podcast, a ?token= feed)? The heuristic lives with the client's add prompt,
// frontend/src/lib/utils/privateFeed.ts, and is imported from there (as the
// lexicons are from the repo root) so the prompt and the server's default never
// disagree about which feeds look private.
export { privateFeedSignal } from '../../../frontend/src/lib/utils/privateFeed';
