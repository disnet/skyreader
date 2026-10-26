import { articlesStore } from '$lib/stores/articles.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import { savesStore } from '$lib/stores/saves.svelte';
import { socialStore } from '$lib/stores/social.svelte';
import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { unreadCounts } from '$lib/stores/unreadCounts.svelte';
import { ACTIONS, HANDLES, openDocument, perform } from './actions';
import { workspaceShellOrigin } from './frame';
import { contextFor, nudgeCount } from './items';
import {
  PROTO,
  cleanItem,
  parseShellMessage,
  type AccountRef,
  type WorkspaceItem,
} from './protocol';

// Skyreader's side of the atworkplace shell protocol (`atworkplace/1`, atlauncher
// docs/PROTOCOL.md; docs/plans/ATWORKPLACE.md here). It tells the shell who's
// signed in, the unread count of the channels marked worth a nudge, and what's
// being read; answers "what links here" from what this device holds; opens the
// standard.site documents the shell routes here; and runs the actions it offers
// other apps (save a page or document, follow a publication).
//
// Skyreader holds one session per browser partition, so `sessions` is that one
// account or nothing, and anything addressed to another account is answered
// `needs-sign-in`.

let send: ((message: Record<string, unknown>) => void) | null = null;
let connected = $state(false);

/** Whether Skyreader is running inside a workspace shell it talks to. */
export const workspace = {
  get connected() {
    return connected;
  },
};

/**
 * Hand `item` to the shell, which offers it to the other apps' actions
 * ("Send to…"). A no-op outside a workspace.
 */
export function offerToWorkspace(item: WorkspaceItem): void {
  const did = auth.user?.did;
  send?.({ type: 'act', item: cleanItem(item), ...(did ? { did } : {}) });
}

// What's being read. Each open reader or expanded card holds its item for as
// long as it's open; the shell is told about the newest hold, so closing a
// reader opened over an expanded card falls back to the card. Coalesced to one
// message per tick, since a reader switching items releases one hold and takes
// the next in the same tick.
const holds: { item: WorkspaceItem }[] = [];
let focusQueued = false;
let lastFocus = 'null';

function flushFocus() {
  focusQueued = false;
  const item = holds.at(-1)?.item ?? null;
  const signature = JSON.stringify(item);
  if (signature === lastFocus) return;
  lastFocus = signature;
  send?.({ type: 'focus', item });
}

function queueFocus() {
  if (focusQueued) return;
  focusQueued = true;
  queueMicrotask(flushFocus);
}

/**
 * Tell the shell `item` is being read, until the returned function is called.
 * A no-op outside a workspace.
 */
export function holdFocus(item: WorkspaceItem): () => void {
  if (!send) return () => {};
  const hold = { item: cleanItem(item) };
  holds.push(hold);
  queueFocus();
  return () => {
    const at = holds.indexOf(hold);
    if (at === -1) return;
    holds.splice(at, 1);
    queueFocus();
  };
}

function context(item: WorkspaceItem): WorkspaceItem[] {
  return contextFor(item, {
    findSave: (guidOrUrl) => savesStore.find(guidOrUrl),
    articles: articlesStore.allArticles,
    feedTitle: (id) => subscriptionsStore.subscriptions.find((s) => s.id === id)?.title,
    documents: socialStore.documents,
    highlightsFor: (key) => itemLabelsStore.getHighlights(key),
    allHighlights: itemLabelsStore.allHighlights,
  });
}

/** Starts talking to the shell, if Skyreader is in one. Returns a stop function. */
export function startWorkspaceBridge(): () => void {
  const shell = workspaceShellOrigin();
  if (!shell) return () => {};

  const post = (message: Record<string, unknown>) =>
    window.parent.postMessage({ proto: PROTO, ...message }, shell);
  const accounts = (did: string | null) => ({ sessions: did ? [did] : [], active: did });

  post({
    type: 'hello',
    app: { name: 'Skyreader' },
    ...accounts(auth.user?.did ?? null),
    handles: HANDLES,
    actions: ACTIONS,
  });
  send = post;
  connected = true;

  const stopEffects = $effect.root(() => {
    const did = $derived(auth.user?.did ?? null);

    // `state` whenever the signed-in account changes (sign-in, sign-out, expiry).
    // Keyed on the DID alone: a session check re-sets the same user often.
    let last = did;
    $effect(() => {
      if (did === last) return;
      last = did;
      post({ type: 'state', ...accounts(did) });
    });

    // The badge, as a full snapshot: no nudge channels (or no session) is no count.
    const count = $derived.by(() => {
      if (!did) return 0;
      const views = filteredViewsStore.views;
      if (!views.some((v) => v.nudge)) return 0;
      return nudgeCount(views, unreadCounts.channelCounts);
    });
    $effect(() => {
      post({ type: 'unread', counts: did && count > 0 ? [{ did, count }] : [] });
    });
  });

  // A request addressed to an account other than the signed-in one can't be
  // done here: say so, and the shell offers sign-in. Returns the DID to act as,
  // or null when there's none.
  const asAccount = (account: AccountRef | undefined): string | null => {
    const did = auth.user?.did ?? null;
    if (account && account.did !== did) {
      post({ type: 'needs-sign-in', did: account.did });
      return null;
    }
    return did;
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== shell) return;
    const message = parseShellMessage(event.data);
    if (!message) return;
    const did = auth.user?.did ?? null;
    switch (message.type) {
      case 'switch':
        if (message.account.did === did) post({ type: 'state', ...accounts(did) });
        else post({ type: 'needs-sign-in', did: message.account.did });
        break;
      case 'sign-out':
        if (message.did === did) void auth.logout();
        break;
      case 'open':
        if (asAccount(message.account)) void openDocument(message.uri);
        else if (!message.account) toastStore.update(toastStore.add('Sign in first'), 'error');
        break;
      case 'perform': {
        if (!ACTIONS.some((a) => a.id === message.action)) break;
        if (!asAccount(message.account)) {
          if (!message.account) toastStore.update(toastStore.add('Sign in first'), 'error');
          break;
        }
        void perform(message.action, message.item);
        break;
      }
      case 'context-query': {
        // Only the signed-in account's items, and only to the shell.
        const mine = did && (!message.did || message.did === did);
        post({ type: 'context', query: message.query, items: mine ? context(message.item) : [] });
        break;
      }
    }
  };
  window.addEventListener('message', onMessage);

  return () => {
    window.removeEventListener('message', onMessage);
    stopEffects();
    send = null;
    connected = false;
    holds.length = 0;
    lastFocus = 'null';
  };
}
