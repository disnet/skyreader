// The messages of the atworkplace shell protocol (`atworkplace/1`) that
// Skyreader sends and takes. The protocol's own definition is atlauncher's
// protocol/messages.ts (prose in its docs/PROTOCOL.md); this is the slice of it
// Skyreader speaks, checked the same way so a malformed message is dropped
// rather than half-handled.

export const PROTO = 'atworkplace/1';

/**
 * Something one app hands another: a record, a web page, or both. `title` is
 * what the shell shows; `text` is a passage or a line of context.
 */
export interface WorkspaceItem {
  title: string;
  uri?: string;
  url?: string;
  text?: string;
}

export interface AccountRef {
  did: string;
  handle: string;
}

export type ShellMessage =
  | { type: 'switch'; account: AccountRef }
  | { type: 'sign-out'; did: string }
  | { type: 'open'; uri: string; account?: AccountRef }
  | { type: 'perform'; action: string; item: WorkspaceItem; account?: AccountRef }
  | { type: 'context-query'; query: string; item: WorkspaceItem; did?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export const isDid = (v: unknown): v is string =>
  typeof v === 'string' && /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/.test(v);

/** An `at://` URI naming a repo, a collection or a record. */
export const isAtUri = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^at:\/\/[a-zA-Z0-9._:%-]+(\/[a-zA-Z0-9.-]+(\/[a-zA-Z0-9._:~-]+)?)?$/.test(v);

export const isHttpUrl = (v: unknown): v is string =>
  typeof v === 'string' && /^https?:\/\//.test(v);

/** An `at://` URI naming one record in a DID's repo: repo, collection and key. */
export const isRecordUri = (v: unknown): v is string =>
  isAtUri(v) && v.slice('at://'.length).split('/').length === 3 && isDid(repoOf(v));

/** The collection an `at://` URI points into, or null for a bare repo. */
export function collectionOf(uri: string): string | null {
  return uri.slice('at://'.length).split('/')[1] ?? null;
}

/** The repo (a DID, or a handle) an `at://` URI points into. */
export function repoOf(uri: string): string {
  return uri.slice('at://'.length).split('/')[0];
}

const isAccountRef = (v: unknown): v is AccountRef =>
  isObj(v) && isDid(v.did) && typeof v.handle === 'string';

const isOptString = (v: unknown) => v === undefined || typeof v === 'string';

export const isItem = (v: unknown): v is WorkspaceItem =>
  isObj(v) &&
  typeof v.title === 'string' &&
  (v.uri === undefined || isAtUri(v.uri)) &&
  (v.url === undefined || isHttpUrl(v.url)) &&
  isOptString(v.text);

export function parseShellMessage(data: unknown): ShellMessage | null {
  if (!isObj(data) || data.proto !== PROTO) return null;
  const optAccount = data.account === undefined || isAccountRef(data.account);
  switch (data.type) {
    case 'switch':
      return isAccountRef(data.account) ? { type: 'switch', account: data.account } : null;
    case 'sign-out':
      return isDid(data.did) ? { type: 'sign-out', did: data.did } : null;
    case 'open':
      return isAtUri(data.uri) && optAccount
        ? { type: 'open', uri: data.uri, account: data.account as AccountRef | undefined }
        : null;
    case 'perform':
      return typeof data.action === 'string' && isItem(data.item) && optAccount
        ? {
            type: 'perform',
            action: data.action,
            item: data.item,
            account: data.account as AccountRef | undefined,
          }
        : null;
    case 'context-query':
      return typeof data.query === 'string' &&
        isItem(data.item) &&
        (data.did === undefined || isDid(data.did))
        ? { type: 'context-query', query: data.query, item: data.item, did: data.did }
        : null;
    default:
      return null;
  }
}

/**
 * Keep an item within what the shell will take: an `at://` uri and an http(s)
 * url or nothing, so one odd field (a save of a non-web link, a feed guid that
 * isn't a record) doesn't get the whole message dropped.
 */
export function cleanItem(item: WorkspaceItem): WorkspaceItem {
  return {
    title: item.title,
    ...(isAtUri(item.uri) ? { uri: item.uri } : {}),
    ...(isHttpUrl(item.url) ? { url: item.url } : {}),
    ...(item.text ? { text: item.text } : {}),
  };
}
