<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { countUrlSavesThisMonth } from '$lib/utils/usage';
  import { isGrantedSupporter } from '$lib/utils/tier';
  import { supporterLimits } from '$lib/constants/tierLimits';
  import { docsUrl, type DocsPage } from '$lib/constants/docs';
  import { CHROME_EXTENSION_URL, FIREFOX_EXTENSION_URL } from '$lib/utils/saveAnywhere';
  import {
    preferences,
    type ArticleFont,
    type DefaultView,
    ARTICLE_FONT_SIZE_MIN,
    ARTICLE_FONT_SIZE_MAX,
  } from '$lib/stores/preferences.svelte';
  import ImportOPMLModal from '$lib/components/ImportOPMLModal.svelte';
  import LimitNotice from '$lib/components/LimitNotice.svelte';
  import { mergeNotices } from '$lib/utils/limitCopy';
  import type { SyncLimitNotice } from '$lib/services/api';
  import SaveBackingPicker from '$lib/components/settings/SaveBackingPicker.svelte';
  import LinkblogTargetPicker from '$lib/components/settings/LinkblogTargetPicker.svelte';
  import DeleteLinkblogModal from '$lib/components/settings/DeleteLinkblogModal.svelte';
  import Diagnostics from '$lib/components/settings/Diagnostics.svelte';
  import HighlightSettings from '$lib/components/settings/HighlightSettings.svelte';
  import SettingToggle from '$lib/components/settings/SettingToggle.svelte';
  import { onAppScroll, appViewportRect } from '$lib/utils/appScroll';
  import StaticPageChrome from '$lib/components/feed/StaticPageChrome.svelte';
  import { myLinkblogStore } from '$lib/stores/myLinkblog.svelte';
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { downloadOPML } from '$lib/utils/opml-exporter';
  import {
    api,
    RateLimitError,
    type BillingSubscription,
    type NewsletterInbox,
  } from '$lib/services/api';
  import { syncStore } from '$lib/stores/sync.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import type {
    LinkblogFormatting,
    LinkblogPublication,
    LinkblogPublicationChoice,
    SaveBacking,
  } from '$lib/types';

  $effect(() => {
    viewTitleStore.set('Settings');
    return () => viewTitleStore.set('');
  });

  const fontOptions: { value: ArticleFont; label: string; family: string }[] = [
    { value: 'sans-serif', label: 'Sans Serif', family: 'sans-serif' },
    { value: 'serif', label: 'Serif', family: 'serif' },
    { value: 'mono', label: 'Monospace', family: 'monospace' },
    { value: 'literata', label: 'Literata', family: 'Literata, serif' },
  ];

  // The page's groups, in order. Each is a <section id> below, and the section
  // nav (a sticky rail on desktop, a chip row on phones) jumps between them.
  // `save-anywhere` and `subscriptions` are linked to from elsewhere in the app,
  // so those ids are load-bearing.
  const allSections = [
    { id: 'account', label: 'Account' },
    { id: 'reading', label: 'Reading' },
    { id: 'library', label: 'Library & privacy' },
    { id: 'linkblog', label: 'Linkblog' },
    { id: 'newsletters', label: 'Newsletters' },
    { id: 'save-anywhere', label: 'Save from anywhere' },
    { id: 'about', label: 'About' },
  ] as const;
  const sections = $derived(
    auth.user
      ? allSections
      : allSections.filter((section) => section.id !== 'account' && section.id !== 'newsletters')
  );

  // Which group the reader is in, for the nav's current marker: the last one
  // whose heading has scrolled past a line a little below the top of the view.
  // At the very bottom the last group wins even if its heading never reaches
  // that line — a short final section would otherwise never light up.
  let activeSection = $state<string>('account');

  function updateActiveSection() {
    const view = appViewportRect();
    const line = view.top + Math.min(160, view.height * 0.3);
    let current: string = sections[0]?.id ?? 'account';
    for (const section of sections) {
      const el = document.getElementById(section.id);
      if (el && el.getBoundingClientRect().top <= line) current = section.id;
    }
    const last = sections.at(-1);
    const lastEl = last && document.getElementById(last.id);
    if (lastEl && lastEl.getBoundingClientRect().bottom <= view.top + view.height + 2) {
      current = last.id;
    }
    activeSection = current;
  }

  onMount(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateActiveSection();
      });
    };
    schedule();
    const stop = onAppScroll(schedule);
    window.addEventListener('resize', schedule);
    return () => {
      stop();
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
    };
  });

  function jumpTo(event: MouseEvent, id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    event.preventDefault();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    activeSection = id;
  }

  const defaultViewOptions: { value: DefaultView; label: string }[] = [
    { value: 'home', label: 'Home' },
    { value: 'feeds', label: 'Feeds' },
    { value: 'saved', label: 'Saved' },
  ];

  let showImportModal = $state(false);

  // "Save from anywhere" — browser bookmarklets + a Share Sheet shortcut.
  // Paste a published iCloud Shortcut link (icloud.com/shortcuts/...) into either
  // constant to turn the manual steps into a one-tap "Add Shortcut" button.
  const APPLE_SAVE_SHORTCUT_URL =
    'https://www.icloud.com/shortcuts/ead7df12455949fa92271ec3d0bea3f7';
  const APPLE_SUBSCRIBE_SHORTCUT_URL =
    'https://www.icloud.com/shortcuts/4b70e834a8ae48ee8c039cbf01e5b8c4';

  // Build links against the current origin so they also work on staging/local.
  const appOrigin = browser ? window.location.origin : 'https://skyreader.app';
  const saveBookmarklet = `javascript:void(window.open('${appOrigin}/save?url='+encodeURIComponent(location.href)))`;
  const subscribeBookmarklet = `javascript:void(window.open('${appOrigin}/subscribe?url='+encodeURIComponent(location.href)))`;

  let copiedKey = $state<string | null>(null);

  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedKey = key;
      setTimeout(() => {
        if (copiedKey === key) copiedKey = null;
      }, 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context); the drag target still works.
    }
  }

  // A bookmarklet is meant to be dragged to the bookmarks bar, not clicked here:
  // the app's CSP blocks the javascript: navigation anyway. The hint above the
  // chips says so, so a click just does nothing rather than navigating.
  function preventBookmarkletClick(e: MouseEvent) {
    e.preventDefault();
  }

  // PDS Sync state
  let pdsSyncEnabled = $state(false);
  let lastSyncSubscriptions = $state<number | null>(null);
  // Feeds whose local edits haven't reached the PDS yet. Normally 0 — every
  // mutation write-throughs — so a non-zero value is the one thing worth saying
  // out loud here, and the manual check is what clears it.
  let pendingSubscriptions = $state(0);
  let isSyncLoading = $state(false);
  let isSyncing = $state(false);
  let syncError = $state<string | null>(null);
  let syncSuccess = $state<string | null>(null);
  // Parked / mirror-cap outcomes from the sync. Held apart from `syncSuccess`,
  // which is a green line: "12 of your feeds were parked" is not good news, and
  // appending it to a success message is how it went unread.
  let syncLimitNotices = $state<SyncLimitNotice[]>([]);
  // Grouped by which cap was hit, so each group carries the raise that applies:
  // an active-feed wall must not be answered with the mirror number.
  const syncFeedNotices = $derived(syncLimitNotices.filter((n) => n.kind === 'feeds'));
  const syncMirrorNotices = $derived(syncLimitNotices.filter((n) => n.kind === 'mirror'));
  // Everything else the sync wants to report — a failed PDS write, a graph
  // listing that was too big to read. These are not plan problems, so they get
  // no upgrade prompt: the backend tells the two apart, we don't guess.
  let syncWarnings = $state<string[]>([]);

  // External-backed saves: which engine holds the Saved list. Owned/managed by
  // <SaveBackingPicker bind:backing>; kept here so the "Library & privacy" overview
  // and the Saved-articles badge can reflect public/private state.
  let backing = $state<SaveBacking>({ provider: 'skyreader' });

  // Live public/private state for the "Library & privacy" overview and per-section badges.
  // Saves are public once a foreign-collection backing engine (Semble/Margin) is on.
  const savesPublic = $derived(backing.provider !== 'skyreader');

  // Linkblog publication settings
  let linkblogPub = $state<LinkblogPublication | null>(null);
  let linkblogName = $state('');
  let linkblogDescription = $state('');
  let isLinkblogLoading = $state(false);
  let isSavingLinkblog = $state(false);
  let linkblogError = $state<string | null>(null);
  let linkblogSuccess = $state<string | null>(null);
  let linkblogChoices = $state<LinkblogPublicationChoice[]>([]);
  let showDeleteLinkblogConfirm = $state(false);
  // Just the host of the Skyreader linkblog page, to name it in copy without
  // spelling out a DID-keyed URL. Falls back to the bare label if `url` is ever
  // unparseable.
  const linkblogPageHost = $derived.by(() => {
    try {
      return new URL(linkblogPub?.url ?? '').hostname;
    } catch {
      return 'Skyreader';
    }
  });
  // The page toggle is bound to a local mirror rather than read straight off
  // `linkblogPub`. A click moves the checkbox itself, so a save that fails leaves
  // no server change for a one-way `checked={...}` to re-assert — the box would
  // sit in the position the user chose while the server still said the opposite.
  // The failure paths write this back; the effect re-syncs it whenever the server
  // value does change.
  let showLinkblogPage = $state(true);
  $effect(() => {
    showLinkblogPage = !linkblogPub?.pageHidden;
  });

  // Post formatting. Same local-mirror reasoning as the page toggle above: a
  // select moves itself, so a failed save needs somewhere to be put back from.
  let titleStyle = $state<LinkblogFormatting['titleStyle']>('link');
  let cardPosition = $state<LinkblogFormatting['cardPosition']>('context');
  $effect(() => {
    titleStyle = linkblogPub?.formatting?.titleStyle ?? 'link';
    cardPosition = linkblogPub?.formatting?.cardPosition ?? 'context';
  });

  // The article title a preview uses. Deliberately generic — the point is the
  // shape of the decoration, not this user's last share.
  const SAMPLE_TITLE = 'The article you linked';
  const titlePreview = $derived(
    titleStyle === 'link'
      ? `🔗 ${SAMPLE_TITLE}`
      : titleStyle === 'quoted'
        ? `“${SAMPLE_TITLE}”`
        : SAMPLE_TITLE
  );

  async function handleSaveFormatting(patch: Partial<LinkblogFormatting>) {
    const revert = () => {
      titleStyle = linkblogPub?.formatting?.titleStyle ?? 'link';
      cardPosition = linkblogPub?.formatting?.cardPosition ?? 'context';
    };
    if (isSavingLinkblog) return revert();
    if (!syncStore.isOnline) {
      linkblogError = 'You are offline. Connect to the internet to change this.';
      return revert();
    }
    isSavingLinkblog = true;
    linkblogError = null;
    linkblogSuccess = null;
    try {
      linkblogPub = await api.setLinkblogFormatting(patch);
      linkblogSuccess = 'Saved. Posts you already published keep the shape they were written in.';
    } catch (error) {
      linkblogError = error instanceof Error ? error.message : 'Could not change this.';
      revert();
    } finally {
      isSavingLinkblog = false;
    }
  }

  // Whether the composer offers the "Posted from Skyreader" checkbox at all.
  // Client-side and per-account (see preferences): the server only ever acts on
  // the per-share flag, so this is about what the composer shows, not what the
  // post carries. The trade is that it doesn't follow you to another device.
  let offerAttribution = $state(false);
  $effect(() => {
    offerAttribution = preferences.linkblogAttributionOffered;
  });

  onMount(async () => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/settings');
      return;
    }
    // Refresh tier/limits from the server. Non-blocking; offline is a no-op.
    void auth.verifySession();
    // Load subscriptions if not already loaded
    if (subscriptionsStore.subscriptions.length === 0) {
      await subscriptionsStore.load();
    }

    // Load PDS sync settings
    await loadSyncSettings();
    await loadLinkblog();
    // Non-blocking; null for anyone without a Polar subscription.
    void loadBillingSubscription();
    void loadNewsletters();
  });

  // ── Newsletters ──
  // The private address mail is sent to. Issued on request, not on load: a
  // reader who never wants one never has one.
  let newsletterInbox = $state<NewsletterInbox | null>(null);
  let newsletterBusy = $state(false);
  let newsletterError = $state<string | null>(null);

  async function loadNewsletters() {
    if (!syncStore.isOnline) return;
    try {
      newsletterInbox = await api.getNewsletters();
    } catch (error) {
      console.error('Failed to load newsletter inbox:', error);
    }
  }

  async function issueNewsletterAddress(rotate: boolean) {
    if (
      rotate &&
      !confirm(
        'Get a new address? The current one stops working, so newsletters sent to it will need your new address.'
      )
    ) {
      return;
    }
    newsletterBusy = true;
    newsletterError = null;
    try {
      const { address } = await api.issueNewsletterAddress(rotate);
      if (newsletterInbox) newsletterInbox = { ...newsletterInbox, address };
      else await loadNewsletters();
    } catch (error) {
      newsletterError = error instanceof Error ? error.message : 'Could not create an address';
    } finally {
      newsletterBusy = false;
    }
  }

  async function unblockNewsletterSender(sender: string) {
    try {
      await api.unblockNewsletterSender(sender);
      if (newsletterInbox) {
        newsletterInbox = {
          ...newsletterInbox,
          blockedSenders: newsletterInbox.blockedSenders.filter((b) => b.sender !== sender),
        };
      }
    } catch (error) {
      newsletterError = error instanceof Error ? error.message : 'Could not unblock that sender';
    }
  }

  // The renewal/end date behind the plan badge, straight from Polar via the
  // backend. Stays null (and renders nothing) offline, for free users, and
  // for supporters granted outside Polar.
  let billingSub = $state<BillingSubscription | null>(null);

  async function loadBillingSubscription() {
    if (!syncStore.isOnline) return;
    try {
      const { subscription } = await api.getBillingSubscription();
      billingSub = subscription;
    } catch (error) {
      console.error('Failed to load billing subscription:', error);
    }
  }

  // Supporter access given by hand (every pre-Polar supporter) has no billing
  // to manage, so the plan card points at the Supporter page for the thank-you
  // rather than for a portal that has no Polar customer behind it.
  const grantedSupporter = $derived(isGrantedSupporter(auth.user));

  // A Believer subscription is still tier 'supporter' in D1; the Polar product
  // name is what distinguishes the badge.
  const planName = $derived.by(() => {
    if (auth.user?.tier !== 'supporter') return 'Free';
    return billingSub?.productName && /believer/i.test(billingSub.productName)
      ? 'Believer'
      : 'Supporter';
  });

  const renewalLine = $derived.by(() => {
    if (!billingSub || auth.user?.tier !== 'supporter') return null;
    const end = billingSub.cancelAtPeriodEnd
      ? (billingSub.endsAt ?? billingSub.currentPeriodEnd)
      : billingSub.currentPeriodEnd;
    const date = new Date(end).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    return billingSub.cancelAtPeriodEnd ? `Ends ${date}` : `Renews ${date}`;
  });

  async function loadLinkblog() {
    if (!syncStore.isOnline) return;
    isLinkblogLoading = true;
    try {
      const [pub, choices] = await Promise.all([
        api.getLinkblogPublication(),
        api.listLinkblogPublications(),
      ]);
      linkblogPub = pub;
      preferences.setLinkblogDisabled(pub.disabled);
      linkblogChoices = choices.publications;
      linkblogName = pub.name;
      linkblogDescription = pub.description ?? '';
    } catch (error) {
      console.error('Failed to load linkblog publication:', error);
    } finally {
      isLinkblogLoading = false;
    }
  }

  function handleDeleteLinkblog() {
    if (isSavingLinkblog) return;
    linkblogSuccess = null;
    if (!syncStore.isOnline) {
      linkblogError = 'You are offline. Connect to the internet to delete your linkblog.';
      return;
    }
    linkblogError = null;
    showDeleteLinkblogConfirm = true;
  }

  async function confirmDeleteLinkblog() {
    if (isSavingLinkblog) return;
    isSavingLinkblog = true;
    linkblogError = null;
    try {
      const result = await api.deleteLinkblog();
      preferences.setLinkblogDisabled(true);
      if (linkblogPub) linkblogPub = { ...linkblogPub, disabled: true, exists: false };
      linkblogSuccess = `Linkblog deleted. ${result.deletedPosts} post${result.deletedPosts === 1 ? '' : 's'} removed.`;
      showDeleteLinkblogConfirm = false;
      // The posts are gone from the PDS, but every card still holds its local
      // share state: without this they keep rendering as shared, with a Remove
      // that would address a record that no longer exists. Same pair the app
      // runs on boot — do it now rather than leaving the window open until then.
      await myLinkblogStore.load(true);
      await linkblogStore.reconcile();
    } catch (error) {
      // A delete that fails partway leaves the linkblog disabled server-side, so
      // re-read the publication rather than trusting the pre-delete copy: the
      // section then shows the deleted state (and its Restore) instead of
      // offering edits that every write path now rejects.
      linkblogError = error instanceof Error ? error.message : 'Could not delete your linkblog.';
      showDeleteLinkblogConfirm = false;
      await loadLinkblog();
    } finally {
      isSavingLinkblog = false;
    }
  }

  async function handleRestoreLinkblog() {
    if (isSavingLinkblog) return;
    linkblogSuccess = null;
    if (!syncStore.isOnline) {
      linkblogError = 'You are offline. Connect to the internet to restore your linkblog.';
      return;
    }
    isSavingLinkblog = true;
    linkblogError = null;
    try {
      linkblogPub = await api.restoreLinkblog();
      preferences.setLinkblogDisabled(false);
      linkblogSuccess = 'Linkblog restored. Deleted posts do not come back.';
    } catch (error) {
      linkblogError = error instanceof Error ? error.message : 'Could not restore your linkblog.';
    } finally {
      isSavingLinkblog = false;
    }
  }

  async function handleConnectLinkblog(selection: {
    uri: string;
    isDefault: boolean;
    format: LinkblogPublication['format'];
  }) {
    if (!selection.uri || isSavingLinkblog) return;
    if (!syncStore.isOnline) {
      linkblogError = 'You are offline. Connect to the internet to change this.';
      return;
    }
    isSavingLinkblog = true;
    linkblogError = null;
    linkblogSuccess = null;
    try {
      // Choosing the Skyreader linkblog is a disconnect — it's always offered,
      // even before its record exists (first share creates it), so there's always
      // a way back from a connected publication.
      const pub = selection.isDefault
        ? await api.disconnectLinkblogPublication()
        : await api.connectLinkblogPublication(selection.uri, selection.format);
      linkblogPub = pub;
      linkblogName = pub.name;
      linkblogDescription = pub.description ?? '';
      linkblogSuccess = pub.external
        ? `New links will publish to ${pub.name}.`
        : 'New links will publish to your Skyreader linkblog.';
    } catch (error) {
      linkblogError = error instanceof Error ? error.message : 'Failed to connect publication.';
    } finally {
      isSavingLinkblog = false;
    }
  }

  // A connected publication already has a public site, so the Skyreader page
  // becomes a second home for the same posts. Worth keeping for most people (it's
  // a stable DID-keyed address with an RSS feed, and it survives switching
  // publications), but it's their call, not ours to infer from the connection.
  async function handleToggleLinkblogPage(show: boolean) {
    // Nothing below saved, so put the checkbox back where the server has it.
    const revert = () => (showLinkblogPage = !linkblogPub?.pageHidden);
    if (isSavingLinkblog) return revert();
    if (!syncStore.isOnline) {
      linkblogError = 'You are offline. Connect to the internet to change this.';
      return revert();
    }
    isSavingLinkblog = true;
    linkblogError = null;
    linkblogSuccess = null;
    try {
      linkblogPub = await api.setLinkblogPageHidden(!show);
      linkblogSuccess = show
        ? 'Your links are showing on Skyreader again.'
        : 'Your Skyreader page is off. Links keep publishing as before.';
    } catch (error) {
      linkblogError = error instanceof Error ? error.message : 'Could not change this.';
      revert();
    } finally {
      isSavingLinkblog = false;
    }
  }

  async function handleSaveLinkblog() {
    if (isSavingLinkblog) return;
    if (!syncStore.isOnline) {
      linkblogError = 'You are offline. Connect to the internet to update your linkblog.';
      return;
    }
    isSavingLinkblog = true;
    linkblogError = null;
    linkblogSuccess = null;
    try {
      const pub = await api.updateLinkblogPublication({
        name: linkblogName,
        description: linkblogDescription,
      });
      linkblogPub = pub;
      linkblogName = pub.name;
      linkblogDescription = pub.description ?? '';
      linkblogSuccess = 'Saved.';
    } catch (error) {
      console.error('Failed to update linkblog publication:', error);
      linkblogError = error instanceof Error ? error.message : 'Failed to save.';
    } finally {
      isSavingLinkblog = false;
    }
  }

  async function loadSyncSettings() {
    if (!syncStore.isOnline) return;
    isSyncLoading = true;
    try {
      const settings = await api.getSettings();
      pdsSyncEnabled = settings.pdsSyncEnabled;
      lastSyncSubscriptions = settings.lastPdsSyncSubscriptions;
      // Only the sync route counts pending writes, and only when sync is on.
      if (settings.pdsSyncEnabled) {
        pendingSubscriptions = (await api.getSyncStatus()).pendingSubscriptions;
      } else {
        pendingSubscriptions = 0;
      }
      // Runs before loadLinkblog and doesn't touch the PDS, so on a device that
      // has never seen this account the linkblog nav hides a beat sooner —
      // and still corrects itself if the publication fetch disagrees.
      preferences.setLinkblogDisabled(settings.linkblogDisabled);
    } catch (error) {
      console.error('Failed to load sync settings:', error);
    } finally {
      isSyncLoading = false;
    }
  }

  async function handleTogglePdsSync(newValue: boolean) {
    syncError = null;
    syncSuccess = null;
    syncWarnings = [];
    syncLimitNotices = [];

    if (!syncStore.isOnline) {
      syncError = 'You are offline. Connect to the internet to change sync settings.';
      pdsSyncEnabled = !newValue;
      return;
    }

    try {
      const settings = await api.updateSettings({ pdsSyncEnabled: newValue });
      pdsSyncEnabled = settings.pdsSyncEnabled;

      // If enabling sync, trigger an initial sync
      if (newValue) {
        await handleSync();
      }
    } catch (error) {
      console.error('Failed to update sync setting:', error);
      syncError = error instanceof Error ? error.message : 'Failed to update setting';
      // Revert the checkbox
      pdsSyncEnabled = !newValue;
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function handleSync() {
    if (isSyncing) return;

    if (!syncStore.isOnline) {
      syncError = 'You are offline. Connect to the internet to sync.';
      return;
    }

    isSyncing = true;
    syncError = null;
    syncSuccess = null;
    syncWarnings = [];
    syncLimitNotices = [];

    // Track totals across multiple sync calls (for batched hasMore syncs)
    let totalPulled = 0;
    let totalPushed = 0;
    let totalImported = 0;
    let totalRemoved = 0;
    let allWarnings: string[] = [];
    let allLimitNotices: SyncLimitNotice[] = [];
    let batchCount = 0;
    const maxBatches = 50; // Safety limit to prevent infinite loops

    try {
      let hasMore = true;

      while (hasMore && batchCount < maxBatches) {
        batchCount++;
        if (batchCount > 1) {
          syncSuccess = 'Still checking...';
        }

        let result;
        try {
          result = await api.triggerFullSync();
        } catch (error) {
          // Handle rate limit by waiting and retrying
          if (error instanceof RateLimitError) {
            const waitSeconds = Math.min(error.retryAfter, 300); // Cap at 5 minutes
            syncSuccess = `Rate limit reached. Waiting ${waitSeconds}s before continuing...`;
            await sleep(waitSeconds * 1000);
            // Retry this batch
            batchCount--;
            continue;
          }
          throw error;
        }

        if (result.needsReauth) {
          syncError = 'Your data moved to a new PDS. Sign in again to reconnect Atmospheric sync.';
          return;
        }

        if (!result.success) {
          syncError = result.error || 'Sync failed';
          return;
        }

        // Accumulate totals
        totalPulled += result.subscriptions?.pulledFromPds || 0;
        totalPushed += result.subscriptions?.pushedToPds || 0;
        totalImported += result.atmosphere?.imported || 0;
        totalRemoved += result.atmosphere?.removed || 0;

        // Collect warnings, keeping plan limits apart from failures.
        allWarnings = [
          ...allWarnings,
          ...(result.subscriptions?.warnings || []),
          ...(result.atmosphere?.warnings || []),
        ];
        allLimitNotices = [
          ...allLimitNotices,
          ...(result.subscriptions?.limitNotices || []),
          ...(result.atmosphere?.limitNotices || []),
        ];

        // Check if there's more to sync
        hasMore = result.hasMore || false;
      }

      // Every subscription edit already writes through to the PDS, so a check
      // that moves nothing is the normal outcome, not a dud. Reporting it as a
      // row of zeroes ("0 pulled, 0 pushed") reads like a failure and is what
      // made this button look like the only thing that syncs. Batch count is
      // plumbing and stays out of it.
      const parts: string[] = [];
      if (totalPulled > 0) parts.push(`${totalPulled} added here`);
      // "sent", not "added": a push here is as often a repair of a record the PDS
      // already holds as it is a new one.
      if (totalPushed > 0) parts.push(`${totalPushed} sent to your PDS`);
      if (totalImported > 0) parts.push(`${totalImported} imported from the Atmosphere`);
      if (totalRemoved > 0) parts.push(`${totalRemoved} removed`);
      syncSuccess = parts.length === 0 ? 'Everything is in step.' : `Done: ${parts.join(', ')}.`;

      // Each pass reports only what it parked or dropped, so the counts are
      // summed into one line per cap — deduping on the sentence would leave a
      // stack of numbers ("20 feeds…", then "30 feeds…"), none of them true.
      syncWarnings = [...new Set(allWarnings)];
      syncLimitNotices = mergeNotices(allLimitNotices);

      // Refresh sync status
      const status = await api.getSyncStatus();
      lastSyncSubscriptions = status.lastSyncSubscriptions;
      pendingSubscriptions = status.pendingSubscriptions;

      // Reload subscriptions to show any pulled items
      await subscriptionsStore.load();
    } catch (error) {
      console.error('Sync error:', error);
      syncError = error instanceof Error ? error.message : 'Sync failed';
    } finally {
      isSyncing = false;
    }
  }

  function formatSyncTime(timestamp: number | null): string {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp * 1000);
    return date.toLocaleString();
  }

  async function handleLogout() {
    if (confirm('Are you sure you want to log out?')) {
      await auth.logout();
      goto('/feeds');
    }
  }
</script>

<StaticPageChrome title="Settings" />

{#snippet visBadge(isPublic: boolean)}
  <span
    class="vis-badge"
    class:public={isPublic}
    title={isPublic ? 'Anyone can see this' : 'Only you, on Skyreader'}
  >
    <Icon name={isPublic ? 'globe' : 'lock'} size={12} />
    {isPublic ? 'Public' : 'Private'}
  </span>
{/snippet}

{#snippet docsLink(key: DocsPage, label = 'Learn more')}
  <a href={docsUrl(key)} target="_blank" rel="noopener noreferrer" class="docs-link">{label}</a>
{/snippet}

<div class="settings-page">
  <nav class="section-nav" aria-label="Settings sections">
    <ul>
      {#each sections as section (section.id)}
        <li>
          <a
            href="#{section.id}"
            class:active={activeSection === section.id}
            aria-current={activeSection === section.id ? 'location' : undefined}
            onclick={(e) => jumpTo(e, section.id)}>{section.label}</a
          >
        </li>
      {/each}
    </ul>
  </nav>

  <div class="settings-content">
    <!-- ── Account ─────────────────────────────────────────────── -->
    {#if auth.user}
      <section class="group" id="account" aria-labelledby="account-title">
        <h2 id="account-title">Account</h2>

        <div class="panel">
          <div class="row profile">
            {#if auth.user.avatarUrl}
              <img src={auth.user.avatarUrl} alt="" class="avatar" />
            {/if}
            <div class="profile-text">
              <p class="display-name">{auth.user.displayName || auth.user.handle}</p>
              <p class="handle">@{auth.user.handle}</p>
              <p class="did">{auth.user.did}</p>
            </div>
            <button class="btn btn-secondary logout" onclick={handleLogout}>
              <Icon name="log-out" size={15} />
              Log Out
            </button>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title-line">
              <h3>Plan</h3>
              <span class="plan-name">{planName}</span>
              {#if renewalLine}
                <span class="plan-renewal">{renewalLine}</span>
              {/if}
            </div>
          </div>

          {#if auth.user.limits}
            {@const subCount = subscriptionsStore.subscriptions.length}
            {@const subLimit = auth.user.limits.maxSubscriptions}
            {@const urlSaveLimit = auth.user.limits.maxUrlSavesPerMonth}
            {@const urlSaveCount = countUrlSavesThisMonth(savesStore.articles)}
            <div class="row plan-limits">
              <div class="limit-row">
                <div class="limit-label">
                  <span>Feed subscriptions</span>
                  <span class="limit-numbers">{subCount} / {subLimit}</span>
                </div>
                <div class="limit-bar">
                  <div
                    class="limit-bar-fill"
                    class:limit-bar-warning={subCount / subLimit > 0.8}
                    class:limit-bar-full={subCount >= subLimit}
                    style:transform="translateX({Math.min((subCount / subLimit) * 100, 100) -
                      100}%)"
                  ></div>
                </div>
              </div>

              <div class="limit-row">
                <div class="limit-label">
                  <span>URL saves this month</span>
                  <span class="limit-numbers">{urlSaveCount} / {urlSaveLimit}</span>
                </div>
                <div class="limit-bar">
                  <div
                    class="limit-bar-fill"
                    class:limit-bar-warning={urlSaveCount / urlSaveLimit > 0.8}
                    class:limit-bar-full={urlSaveCount >= urlSaveLimit}
                    style:transform="translateX({Math.min(
                      (urlSaveCount / urlSaveLimit) * 100,
                      100
                    ) - 100}%)"
                  ></div>
                </div>
              </div>
            </div>
          {/if}

          <div class="row plan-footer">
            {#if auth.user.tier !== 'supporter'}
              <p class="row-desc">
                Supporters get {supporterLimits.feeds} feeds, {supporterLimits.saves} saves a month, and
                keep Skyreader independent.
              </p>
              <a href="/supporter" class="btn btn-primary">Become a Supporter</a>
            {:else if grantedSupporter}
              <p class="row-desc">
                Supporter access is yours at no charge, as thanks for supporting Skyreader early.
                More on the <a href="/supporter">Supporter page</a>.
              </p>
            {:else}
              <!-- The billing portal itself is launched from /supporter, which owns
                   the async Polar-session handler; this stays a plain link. -->
              <p class="row-desc">
                Manage billing, change plans, or cancel from the <a href="/supporter"
                  >Supporter page</a
                >.
              </p>
            {/if}
          </div>
        </div>
      </section>
    {/if}

    <!-- ── Reading ─────────────────────────────────────────────── -->
    <section class="group" id="reading" aria-labelledby="reading-title">
      <h2 id="reading-title">Reading</h2>

      <div class="panel">
        <div class="panel-head">
          <h3>Article text</h3>
        </div>
        <div class="row stack">
          <span class="row-label" id="article-font-label">Font</span>
          <div class="font-options" role="group" aria-labelledby="article-font-label">
            {#each fontOptions as option}
              <button
                class="font-option"
                class:selected={preferences.articleFont === option.value}
                aria-pressed={preferences.articleFont === option.value}
                onclick={() => preferences.setArticleFont(option.value)}
              >
                <span class="font-preview" style:font-family={option.family}>Aa</span>
                <span class="font-label">{option.label}</span>
              </button>
            {/each}
          </div>
        </div>
        <div class="row inline">
          <span class="row-label" id="article-size-label">Size</span>
          <div class="font-size-control" role="group" aria-labelledby="article-size-label">
            <button
              class="size-step"
              onclick={() => preferences.decreaseFontSize()}
              disabled={preferences.articleFontSize <= ARTICLE_FONT_SIZE_MIN}
              aria-label="Decrease font size"
            >
              <span class="size-glyph size-glyph-sm">A</span>
            </button>
            <span class="size-readout">{preferences.articleFontSize}<small>px</small></span>
            <button
              class="size-step"
              onclick={() => preferences.increaseFontSize()}
              disabled={preferences.articleFontSize >= ARTICLE_FONT_SIZE_MAX}
              aria-label="Increase font size"
            >
              <span class="size-glyph size-glyph-lg">A</span>
            </button>
          </div>
        </div>
        <!-- The choice above, set the way an article will be. A reader picking a
             face shouldn't have to open an article to see what they picked. -->
        <div class="row">
          <p
            class="type-sample"
            style:font-family={fontOptions.find((o) => o.value === preferences.articleFont)?.family}
            style:font-size="{preferences.articleFontSize}px"
            aria-hidden="true"
          >
            A quiet place to read deeply and think clearly. Everything you follow, in one calm room.
          </p>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3>Getting around</h3>
        </div>
        <div class="row inline wrap">
          <div class="row-text">
            <span class="row-label" id="default-view-label">Open to</span>
            <span class="row-desc">Which view loads first when you open Skyreader.</span>
          </div>
          <div class="segmented" role="group" aria-labelledby="default-view-label">
            {#each defaultViewOptions as option}
              <button
                class="segment"
                class:selected={preferences.defaultView === option.value}
                aria-pressed={preferences.defaultView === option.value}
                onclick={() => preferences.setDefaultView(option.value)}
              >
                {option.label}
              </button>
            {/each}
          </div>
        </div>
        <div class="row">
          <SettingToggle
            label="Mark articles as read when scrolled past"
            checked={preferences.scrollToMarkAsRead}
            onchange={(checked) => preferences.setScrollToMarkAsRead(checked)}
          >
            Articles you scroll past in the feed count as read.
          </SettingToggle>
        </div>
      </div>

      <!-- Deck size lives with the deck it configures; the Margin toggle cannot,
           because a reader with a Margin library and no Skyreader highlights has
           no Review entry in the nav to find the deck's gear behind. -->
      <div class="panel">
        <div class="panel-head">
          <h3>Highlights</h3>
          <p class="row-desc">
            Your highlights are private to Skyreader. Saving one to Margin publishes that note to
            your public PDS.
            {@render docsLink('highlights')}
          </p>
        </div>
        <div class="row">
          <SettingToggle
            label="Show community highlights"
            checked={preferences.communityHighlights}
            onchange={(checked) => preferences.setCommunityHighlights(checked)}
          >
            Passages other readers highlighted on Margin, shown while you read saved articles.
          </SettingToggle>
        </div>
        <div class="row">
          <HighlightSettings showDeckSize={false} />
        </div>
      </div>
    </section>

    <!-- ── Library & privacy ───────────────────────────────────── -->
    <section class="group" id="library" aria-labelledby="library-title">
      <h2 id="library-title">Library &amp; privacy</h2>
      <p class="group-lead">
        Your reading is private to you on Skyreader by default. A few things can be made public, so
        they're portable across the Atmosphere.
        {@render docsLink('yourData', 'The full picture')}
      </p>

      <!-- At a glance: where each kind of data stands. Each row jumps to the
           panel that changes it. -->
      <div class="panel">
        {#if isSyncLoading}
          <div class="row"><p class="loading">Loading…</p></div>
        {:else}
          <ul class="vis-overview">
            <li>
              <a href="#subscriptions" onclick={(e) => jumpTo(e, 'subscriptions')}>Subscriptions</a>
              {@render visBadge(pdsSyncEnabled)}
            </li>
            <li>
              <a href="#saved" onclick={(e) => jumpTo(e, 'saved')}>Saved articles</a>
              {@render visBadge(savesPublic)}
            </li>
            <li>
              <a href="#linkblog" onclick={(e) => jumpTo(e, 'linkblog')}>Shared links</a>
              {@render visBadge(true)}
            </li>
          </ul>
          {#if auth.user}
            <div class="row quiet-footer">
              <a
                href="https://pdsls.dev/at://{auth.user.did}"
                target="_blank"
                rel="noopener noreferrer"
                class="pds-link"
                >View your public PDS data
                <Icon name="external-link" size={13} />
              </a>
            </div>
          {/if}
        {/if}
      </div>

      <div class="panel" id="subscriptions">
        <div class="panel-head">
          <div class="panel-title-line spread">
            <h3>Subscriptions</h3>
            {@render visBadge(pdsSyncEnabled)}
          </div>
        </div>

        {#if isSyncLoading}
          <div class="row"><p class="loading">Loading sync settings…</p></div>
        {:else}
          <div class="row">
            <SettingToggle
              label="Atmospheric sync"
              bind:checked={pdsSyncEnabled}
              onchange={handleTogglePdsSync}
            >
              Your feed list is private, stored on Skyreader. Turn this on to also store it on your
              PDS, where it's backed up, portable to any Atmospheric app, and publicly visible. Your
              standard.site follows stay in step either way.
              {@render docsLink('atmosphericSync')}
            </SettingToggle>

            {#if pdsSyncEnabled}
              <div class="sync-status">
                {#if pendingSubscriptions > 0}
                  <p class="sync-live sync-pending">
                    <Icon name="clock" size={14} />
                    <span>
                      {pendingSubscriptions}
                      {pendingSubscriptions === 1 ? 'feed has' : 'feeds have'} changes that haven't reached
                      your PDS yet.
                    </span>
                  </p>
                {:else}
                  <p class="sync-live">
                    <Icon name="check" size={14} />
                    <span
                      >On. Feeds you add, rename, or remove go to your PDS as you change them.</span
                    >
                  </p>
                {/if}

                <div class="sync-recheck">
                  <div>
                    <p class="sync-time">
                      Last full check: {formatSyncTime(lastSyncSubscriptions)}
                    </p>
                    <p class="sync-recheck-hint">
                      {pendingSubscriptions > 0
                        ? 'A check will send them.'
                        : 'Use it if your feed list looks out of step with your PDS.'}
                    </p>
                  </div>
                  <button class="btn btn-secondary" onclick={handleSync} disabled={isSyncing}>
                    {#if isSyncing}
                      Checking…
                    {:else}
                      Check for changes
                    {/if}
                  </button>
                </div>
              </div>
            {/if}

            <!-- Outside the "on" branch: a failed attempt to turn sync on leaves
                 it off, and its error has to stay readable. -->
            {#if syncError}
              <p class="status-error">{syncError}</p>
            {/if}

            {#if pdsSyncEnabled}
              {#if syncSuccess}
                <p class="status-success">{syncSuccess}</p>
              {/if}

              {#if syncFeedNotices.length > 0}
                <div class="sync-warnings">
                  <LimitNotice kind="feeds">
                    {#each syncFeedNotices as notice}
                      <p>{notice.message}</p>
                    {/each}
                  </LimitNotice>
                </div>
              {/if}

              {#if syncMirrorNotices.length > 0}
                <div class="sync-warnings">
                  <LimitNotice kind="mirror">
                    {#each syncMirrorNotices as notice}
                      <p>{notice.message}</p>
                    {/each}
                  </LimitNotice>
                </div>
              {/if}

              {#if syncWarnings.length > 0}
                <div class="sync-warnings">
                  {#each syncWarnings as warning}
                    <p class="sync-warning">{warning}</p>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        {/if}

        <div class="row inline wrap">
          <div class="row-text">
            <span class="row-label">Import &amp; export</span>
            <span class="row-desc">Move your feed list in or out as OPML or a text file.</span>
          </div>
          <div class="button-row">
            <button class="btn btn-secondary" onclick={() => (showImportModal = true)}>
              Import Feeds
            </button>
            <button
              class="btn btn-secondary"
              onclick={() => downloadOPML(subscriptionsStore.subscriptions)}
              disabled={subscriptionsStore.subscriptions.length === 0}
            >
              Export OPML
            </button>
          </div>
        </div>
      </div>

      <div class="panel" id="saved">
        <div class="panel-head">
          <div class="panel-title-line spread">
            <h3>Saved articles</h3>
            {@render visBadge(savesPublic)}
          </div>
          <p class="row-desc">
            Your saves stay private on Skyreader. To turn your whole Saved list into a collection
            you can edit in another app, back it with Semble or Margin. That collection is public.
            You can change this anytime.
            {@render docsLink('saveBacking')}
          </p>
        </div>
        <div class="row">
          <SaveBackingPicker bind:backing allowExport returnUrl="/settings" />
        </div>
      </div>
    </section>

    <!-- ── Linkblog ────────────────────────────────────────────── -->
    <section class="group" id="linkblog" aria-labelledby="linkblog-title">
      <div class="group-title-line">
        <h2 id="linkblog-title">Linkblog</h2>
        {@render visBadge(true)}
      </div>
      <p class="group-lead">
        Sharing an article publishes it to your linkblog, a public publication in your PDS that's
        readable across the Atmosphere. Anyone with the link can read it.
        {@render docsLink('sharingAndLinkblog')}
      </p>

      {#if isLinkblogLoading}
        <div class="panel">
          <div class="row"><p class="loading">Loading linkblog…</p></div>
        </div>
      {:else if linkblogPub?.disabled}
        <div class="panel">
          <div class="row inline wrap">
            <p class="row-desc">Your linkblog is deleted. Deleted posts cannot be restored.</p>
            <button
              class="btn btn-secondary"
              onclick={handleRestoreLinkblog}
              disabled={isSavingLinkblog}
            >
              {isSavingLinkblog ? 'Restoring…' : 'Restore linkblog'}
            </button>
          </div>
        </div>
      {:else}
        {#if linkblogPub}
          <div class="panel">
            <div class="panel-head">
              <div class="panel-title-line spread">
                <h3>Where your links go</h3>
                {#if !linkblogPub.pageHidden}
                  <a
                    class="panel-action"
                    href={linkblogPub.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    >View your linkblog
                    <Icon name="external-link" size={13} />
                  </a>
                {/if}
              </div>
              {#if linkblogPub.pageHidden || linkblogPub.externalUrl}
                <p class="row-desc">
                  {#if linkblogPub.pageHidden}
                    Your Skyreader page is off.
                  {/if}
                  {#if linkblogPub.externalUrl}
                    Your links are going into
                    <a href={linkblogPub.externalUrl} target="_blank" rel="noopener noreferrer"
                      >{linkblogPub.name}</a
                    >, alongside whatever else that publication holds.
                  {/if}
                </p>
              {/if}
            </div>

            <div class="row">
              <LinkblogTargetPicker
                current={linkblogPub}
                choices={linkblogChoices}
                busy={isSavingLinkblog}
                onapply={handleConnectLinkblog}
              />
            </div>

            <!-- Only with a connected publication: without one, this page is the only
                 public address the links have, and turning it off would be a second,
                 quieter way to spell "delete". -->
            {#if linkblogPub.external}
              <div class="row">
                <SettingToggle
                  label="Also show my links on Skyreader"
                  bind:checked={showLinkblogPage}
                  disabled={isSavingLinkblog}
                  onchange={handleToggleLinkblogPage}
                >
                  A page at {linkblogPageHost} that lists only your links, with its own RSS feed. It keeps
                  working if you change publications later. Turn it off to send readers to
                  {linkblogPub.name} only.
                </SettingToggle>
              </div>
            {/if}
          </div>
        {/if}

        <!-- How a post reads where other people read it. These matter most on a
             connected publication (leaflet.pub, Offprint), where a link post sits
             beside that site's own writing — but they're written into every record,
             so they're offered either way. -->
        <div class="panel">
          <div class="panel-head">
            <h3>How your posts read</h3>
          </div>
          <div class="row field-row">
            <div class="row-text">
              <label class="row-label" for="linkblog-title-style">Post title</label>
              <span class="row-desc">
                Marks the post as a link rather than a copy of the article. Shows as
                <strong>{titlePreview}</strong>. Skyreader always shows the plain title.
              </span>
            </div>
            <select
              id="linkblog-title-style"
              class="field"
              bind:value={titleStyle}
              disabled={isSavingLinkblog}
              onchange={(e) =>
                handleSaveFormatting({
                  titleStyle: e.currentTarget.value as LinkblogFormatting['titleStyle'],
                })}
            >
              <option value="link">🔗 with the article title</option>
              <option value="quoted">The article title in quotes</option>
              <option value="plain">The article title exactly</option>
            </select>
          </div>

          <div class="row field-row">
            <div class="row-text">
              <label class="row-label" for="linkblog-card-position">Link card</label>
              <span class="row-desc">
                Where the article sits in the post. With the quote, a reader knows what you're
                responding to before they read the response.
              </span>
            </div>
            <select
              id="linkblog-card-position"
              class="field"
              bind:value={cardPosition}
              disabled={isSavingLinkblog}
              onchange={(e) =>
                handleSaveFormatting({
                  cardPosition: e.currentTarget.value as LinkblogFormatting['cardPosition'],
                })}
            >
              <option value="context">With the quote, above your commentary</option>
              <option value="top">First</option>
              <option value="bottom">Last</option>
            </select>
          </div>

          <div class="row">
            <SettingToggle
              label="Offer a “Posted from Skyreader” line when sharing"
              bind:checked={offerAttribution}
              onchange={(checked) => preferences.setLinkblogAttributionOffered(checked)}
            >
              Adds a checkbox to the composer. Nothing is added to a post unless you tick it. This
              switch is for this device.
            </SettingToggle>
          </div>
        </div>

        <!-- Name/description belong to the Skyreader linkblog only. A connected
             publication is its home app's record; Skyreader doesn't rename it. -->
        <div class="panel">
          <div class="panel-head">
            <h3>Your Skyreader linkblog</h3>
            {#if linkblogPub?.external}
              <p class="row-desc">
                <strong>{linkblogPub.name}</strong> is managed by its own app — change its name, description
                and appearance there. Your Skyreader linkblog keeps its own name, ready if you switch
                back.
              </p>
            {/if}
          </div>
          {#if !linkblogPub?.external}
            <div class="row form">
              <div class="form-field">
                <label for="linkblog-name">Name</label>
                <input
                  id="linkblog-name"
                  class="field"
                  type="text"
                  bind:value={linkblogName}
                  maxlength="120"
                  placeholder="My links"
                />
              </div>
              <div class="form-field">
                <label for="linkblog-description">Description</label>
                <textarea
                  id="linkblog-description"
                  class="field"
                  bind:value={linkblogDescription}
                  rows="2"
                  maxlength="500"
                  placeholder="Optional"></textarea>
              </div>
              <div>
                <button
                  class="btn btn-secondary"
                  onclick={handleSaveLinkblog}
                  disabled={isSavingLinkblog}
                >
                  {#if isSavingLinkblog}Saving…{:else}Save{/if}
                </button>
              </div>
            </div>
          {/if}
        </div>

        <div class="panel danger-panel">
          <div class="row inline wrap">
            <div class="row-text">
              <span class="row-label">Delete linkblog</span>
              <span class="row-desc">
                Deletes every link post from your PDS and removes the linkblog from Skyreader. This
                cannot be undone.
              </span>
            </div>
            <button
              class="btn btn-danger"
              onclick={handleDeleteLinkblog}
              disabled={isSavingLinkblog}
            >
              Delete linkblog
            </button>
          </div>
        </div>
      {/if}
      <!-- Outside the branches above: delete and restore both report here, and each
           one switches which branch is rendered. Nested in either, the delete's
           "N posts removed" and a failed restore's error would never be seen. -->
      {#if linkblogError}
        <p class="status-error">{linkblogError}</p>
      {/if}
      {#if linkblogSuccess}
        <p class="status-success">{linkblogSuccess}</p>
      {/if}
    </section>

    <!-- ── Newsletters ─────────────────────────────────────────── -->
    {#if auth.user}
      <section class="group" id="newsletters" aria-labelledby="newsletters-title">
        <h2 id="newsletters-title">Newsletters</h2>
        <p class="group-lead">
          Read your email newsletters here, away from the inbox. Each sender becomes a source.
          {@render docsLink('newsletters')}
        </p>

        <div class="panel">
          {#if !newsletterInbox}
            <div class="row">
              <p class="loading">{syncStore.isOnline ? 'Loading…' : 'Available when online.'}</p>
            </div>
          {:else if !newsletterInbox.enabled}
            <div class="row">
              <p class="row-desc">Newsletter delivery isn't available here yet.</p>
            </div>
          {:else if newsletterInbox.entitled && newsletterInbox.address}
            <div class="row stack">
              <div class="row-text">
                <span class="row-label">Your newsletter address</span>
                <p class="row-desc">
                  Use it when you sign up for a newsletter, or forward issues to it. Keep it to
                  yourself: anything sent here lands in your reader.
                </p>
              </div>
              <code class="newsletter-address">{newsletterInbox.address}</code>
              <div class="button-row">
                <button
                  class="btn btn-primary"
                  onclick={() => copyText(newsletterInbox!.address!, 'newsletter')}
                >
                  {copiedKey === 'newsletter' ? 'Copied' : 'Copy address'}
                </button>
                <button
                  class="btn btn-secondary"
                  disabled={newsletterBusy}
                  onclick={() => issueNewsletterAddress(true)}
                >
                  Get a new address
                </button>
              </div>
            </div>
          {:else if newsletterInbox.entitled}
            <div class="row stack">
              <p class="row-desc">
                Get a private address to sign up with. Your newsletters arrive in your reader, not
                your inbox.
              </p>
              <div class="button-row">
                <button
                  class="btn btn-primary"
                  disabled={newsletterBusy}
                  onclick={() => issueNewsletterAddress(false)}
                >
                  {newsletterBusy ? 'Creating…' : 'Create my address'}
                </button>
              </div>
            </div>
          {:else}
            <div class="row stack">
              {#if newsletterInbox.address}
                <p class="row-desc">
                  <code>{newsletterInbox.address}</code> isn't receiving mail while you're off the Supporter
                  plan. Newsletters you already have stay readable.
                </p>
              {:else}
                <p class="row-desc">
                  Newsletters by email are part of the Supporter plan: one private address, and
                  every newsletter you send to it becomes a source in your reader.
                </p>
              {/if}
              <div class="button-row">
                <a href="/supporter" class="btn btn-primary">Become a Supporter</a>
              </div>
            </div>
          {/if}

          {#if newsletterInbox && newsletterInbox.blockedSenders.length > 0}
            <div class="row stack">
              <div class="row-text">
                <span class="row-label">Blocked senders</span>
                <p class="row-desc">
                  Removing a newsletter blocks its sender. Unblock one to let its mail back in.
                </p>
              </div>
              <ul class="blocked-senders">
                {#each newsletterInbox.blockedSenders as blocked (blocked.sender)}
                  <li>
                    <span class="blocked-sender">{blocked.sender}</span>
                    <button
                      class="btn btn-secondary"
                      onclick={() => unblockNewsletterSender(blocked.sender)}
                    >
                      Unblock
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
        {#if newsletterError}
          <p class="status-error">{newsletterError}</p>
        {/if}
      </section>
    {/if}

    <!-- ── Save from anywhere ──────────────────────────────────── -->
    <section class="group" id="save-anywhere" aria-labelledby="save-anywhere-title">
      <h2 id="save-anywhere-title">Save from anywhere</h2>
      <p class="group-lead">
        Save an article or subscribe to a feed without leaving the page you're reading.
        {@render docsLink('saveFromAnywhere')}
      </p>

      <!-- Three independent setups, not one procedure: each platform is its own
           row with one recommended action at rest, and the secondary paths (the
           bookmarklet, the manual Shortcuts recipe) fold away. -->
      <div class="panel">
        <div class="row">
          <span class="row-label">On your computer</span>
          <p class="row-desc">
            The extension saves the page you're on in one click, including articles the reader can't
            fetch on its own.
          </p>
          <div class="button-row">
            <a
              class="btn btn-secondary"
              href={CHROME_EXTENSION_URL}
              target="_blank"
              rel="noopener noreferrer">Chrome extension</a
            >
            <a
              class="btn btn-secondary"
              href={FIREFOX_EXTENSION_URL}
              target="_blank"
              rel="noopener noreferrer">Firefox extension</a
            >
          </div>

          <details class="disclosure">
            <summary>Use a bookmarklet instead</summary>
            <p class="row-desc">
              Drag either button to your bookmarks bar, then click it on any page. Clicking them
              here won't work.
            </p>
            <div class="bookmarklet-row">
              <a class="bookmarklet" href={saveBookmarklet} onclick={preventBookmarkletClick}>
                Save to Skyreader
              </a>
              <a class="bookmarklet" href={subscribeBookmarklet} onclick={preventBookmarkletClick}>
                Subscribe in Skyreader
              </a>
            </div>
            <div class="button-row">
              <button class="btn btn-secondary" onclick={() => copyText(saveBookmarklet, 'save')}>
                {copiedKey === 'save' ? 'Copied' : 'Copy Save link'}
              </button>
              <button
                class="btn btn-secondary"
                onclick={() => copyText(subscribeBookmarklet, 'subscribe')}
              >
                {copiedKey === 'subscribe' ? 'Copied' : 'Copy Subscribe link'}
              </button>
            </div>
          </details>
        </div>

        <div class="row">
          <span class="row-label">On iPhone or iPad</span>
          {#if APPLE_SAVE_SHORTCUT_URL || APPLE_SUBSCRIBE_SHORTCUT_URL}
            <p class="row-desc">Add a shortcut, then use it from any Share Sheet.</p>
            <div class="button-row">
              {#if APPLE_SAVE_SHORTCUT_URL}
                <a
                  class="btn btn-secondary"
                  href={APPLE_SAVE_SHORTCUT_URL}
                  target="_blank"
                  rel="noopener noreferrer">Add Save shortcut</a
                >
              {/if}
              {#if APPLE_SUBSCRIBE_SHORTCUT_URL}
                <a
                  class="btn btn-secondary"
                  href={APPLE_SUBSCRIBE_SHORTCUT_URL}
                  target="_blank"
                  rel="noopener noreferrer">Add Subscribe shortcut</a
                >
              {/if}
            </div>
          {:else}
            <p class="row-desc">
              Build a Share Sheet shortcut once, then use it from any app. It opens here and saves
              while you stay logged in.
            </p>
            <details class="disclosure shortcut-steps">
              <summary>Show the steps</summary>
              <ol>
                <li>Open the <strong>Shortcuts</strong> app and create a new shortcut.</li>
                <li>
                  In its settings, turn on <strong>Show in Share Sheet</strong> and set the type to
                  <strong>URLs</strong>.
                </li>
                <li>Add <strong>Get URLs from Input</strong>, set to Shortcut Input.</li>
                <li>Add <strong>URL Encode</strong> (Encode) on that URL.</li>
                <li>
                  Add <strong>Text</strong>: <code>{appOrigin}/save?url=</code> followed by the
                  Encoded URL. Use <code>/subscribe?url=</code> instead for a feed shortcut.
                </li>
                <li>Add <strong>Open URLs</strong> with that text.</li>
              </ol>
            </details>
          {/if}
        </div>

        <div class="row">
          <span class="row-label">On Android</span>
          <p class="row-desc">
            Install Skyreader to your home screen and it appears right in the system share sheet.
            Share any page, pick Skyreader, and it saves the article. No setup needed.
          </p>
        </div>
      </div>
    </section>

    <!-- ── About ───────────────────────────────────────────────── -->
    <section class="group" id="about" aria-labelledby="about-title">
      <h2 id="about-title">About</h2>

      <div class="panel">
        <div class="row">
          <p class="about-text">
            Skyreader is a reading app that helps you make sense of what you read. Your reading
            lives on Skyreader and stays private by default; much of it can be made portable across
            the Atmosphere, stored on your own Personal Data Server (PDS).
          </p>
          <nav class="about-links" aria-label="About Skyreader">
            <a href={docsUrl('home')} target="_blank" rel="noopener noreferrer">Docs</a>
            <a href="/feedback">Feedback</a>
            <a href="/terms">Terms of Service</a>
            <a href="/privacy">Privacy Policy</a>
            <a href="mailto:abuse@skyreader.app">Report Abuse</a>
          </nav>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3>Diagnostics</h3>
          <p class="row-desc">
            What this device is running. Useful to include when something looks wrong.
          </p>
        </div>
        <div class="row">
          <Diagnostics />
        </div>
      </div>
    </section>
  </div>
</div>

<ImportOPMLModal open={showImportModal} onclose={() => (showImportModal = false)} />

<DeleteLinkblogModal
  open={showDeleteLinkblogConfirm}
  busy={isSavingLinkblog}
  onconfirm={confirmDeleteLinkblog}
  oncancel={() => (showDeleteLinkblogConfirm = false)}
/>

<style>
  /* ── Layout ───────────────────────────────────────────────────
     A single column of groups. Above the shell breakpoint the section nav
     becomes a sticky rail beside it; below, a row of chips above it. */
  .settings-page {
    max-width: 880px;
    margin: 0 auto;
    padding: 2.5rem 1rem 4rem;
    display: grid;
    grid-template-columns: 11rem minmax(0, 1fr);
    gap: 2.5rem;
    align-items: start;
  }

  .settings-content {
    max-width: 640px;
    min-width: 0;
  }

  @media (max-width: 1000px) {
    .settings-page {
      display: block;
      padding: 0.5rem 0 calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1.5rem);
    }
  }

  /* ── Section nav ──────────────────────────────────────────── */
  .section-nav {
    position: sticky;
    top: 1.5rem;
  }

  .section-nav ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .section-nav a {
    display: block;
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    text-decoration: none;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .section-nav a:hover {
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }

  .section-nav a.active {
    color: var(--color-primary);
    background: var(--color-sidebar-active);
  }

  @media (max-width: 1000px) {
    .section-nav {
      position: static;
      margin: 0 -1rem 1.25rem;
    }

    /* A row of chips that scrolls sideways rather than wrapping into a block
       of buttons above the page. */
    .section-nav ul {
      flex-direction: row;
      gap: 0.375rem;
      overflow-x: auto;
      padding: 0 1rem;
      scrollbar-width: none;
    }

    .section-nav ul::-webkit-scrollbar {
      display: none;
    }

    .section-nav a {
      white-space: nowrap;
      padding: 0.375rem 0.75rem;
      border-radius: 999px;
      background: var(--color-bg-secondary);
      font-size: var(--text-sm);
    }
  }

  /* ── Groups ───────────────────────────────────────────────── */
  .group {
    scroll-margin-top: 1.5rem;
  }

  .group + .group {
    margin-top: 3rem;
  }

  .group h2 {
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
    line-height: var(--leading-tight);
    margin: 0 0 0.75rem;
  }

  .group-title-line {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-bottom: 0.75rem;
  }

  .group-title-line h2 {
    margin: 0;
  }

  .group-lead {
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
    max-width: 60ch;
    margin: -0.25rem 0 1rem;
  }

  /* ── Panels and rows ──────────────────────────────────────────
     A panel is one card of related settings; rows inside it are divided by
     hairlines rather than boxed, so there's never a card inside a card. */
  .panel {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    scroll-margin-top: 1.5rem;
  }

  .panel + .panel {
    margin-top: 1rem;
  }

  .panel-head {
    padding: 0.875rem 1rem 0;
  }

  .panel-head h3 {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    margin: 0;
  }

  .panel-head .row-desc {
    margin-top: 0.25rem;
  }

  /* The head and its first row read as one block: no divider between them,
     and only a little air. */
  .panel-head + .row {
    padding-top: 0.625rem;
  }

  .panel-head:has(.row-desc) + .row {
    padding-top: 0.875rem;
  }

  .panel-title-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
  }

  .panel-title-line.spread {
    justify-content: space-between;
  }

  .panel-action {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    text-decoration: none;
  }

  .panel-action:hover {
    text-decoration: underline;
  }

  .row {
    padding: 0.875rem 1rem;
  }

  .row + .row {
    border-top: 1px solid var(--color-border);
  }

  /* Label on the left, control on the right. */
  .row.inline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem 1rem;
  }

  .row.inline.wrap {
    flex-wrap: wrap;
  }

  .row.stack {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .row-text {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
    flex: 1 1 16rem;
  }

  .row-label {
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .row-desc {
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
    margin: 0;
  }

  .row > .row-label + .row-desc {
    margin-top: 0.2rem;
  }

  .row > .row-desc + .button-row {
    margin-top: 0.75rem;
  }

  .loading {
    margin: 0;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  /* Buttons here are Label type, like everywhere else in the chrome; the
     shared .btn leaves size to its context. Anchors wearing .btn (the
     extension and shortcut links) drop the link underline. */
  .settings-page :global(.btn) {
    font-size: var(--text-md);
    text-decoration: none;
  }

  .button-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .newsletter-address {
    display: block;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: var(--text-md);
    overflow-wrap: anywhere;
    user-select: all;
  }

  .blocked-senders {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .blocked-senders li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .blocked-sender {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .docs-link {
    color: var(--color-primary);
    text-decoration: none;
    white-space: nowrap;
  }

  .docs-link:hover {
    text-decoration: underline;
  }

  .status-error,
  .status-success {
    font-size: var(--text-md);
    margin: 0.75rem 0 0;
  }

  .status-error {
    color: var(--color-error);
  }

  .status-success {
    color: var(--color-success);
  }

  /* ── Account ──────────────────────────────────────────────── */
  .profile {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .avatar {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .profile-text {
    flex: 1;
    min-width: 0;
  }

  .profile-text p {
    margin: 0;
  }

  .display-name {
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
  }

  .handle {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .did {
    margin-top: 0.125rem !important;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    word-break: break-all;
  }

  .logout {
    flex-shrink: 0;
  }

  @media (max-width: 640px) {
    .profile {
      flex-wrap: wrap;
    }

    .logout {
      width: 100%;
    }
  }

  .plan-name {
    display: inline-block;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
  }

  .plan-renewal {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .plan-limits {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .limit-row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .limit-label {
    display: flex;
    justify-content: space-between;
    font-size: var(--text-md);
  }

  .limit-numbers {
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .limit-bar {
    height: 6px;
    background: var(--color-bg-secondary);
    border-radius: 999px;
    overflow: hidden;
  }

  .limit-bar-fill {
    /* Full-width fill slid left and clipped by the track, so the fill
       percentage animates on transform instead of layout. */
    width: 100%;
    height: 100%;
    background: var(--color-primary);
    border-radius: 999px;
    transition: transform 0.3s ease;
  }

  .limit-bar-warning {
    background: var(--color-warning);
  }

  .limit-bar-full {
    background: var(--color-error);
  }

  .plan-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem 1rem;
    background: var(--color-bg-secondary);
    border-radius: 0 0 7px 7px;
  }

  .plan-footer .row-desc {
    flex: 1 1 18rem;
  }

  /* ── Reading ──────────────────────────────────────────────── */
  .font-options {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .font-option {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.75rem 0.5rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background-color 0.15s ease;
  }

  .font-option:hover {
    border-color: var(--color-primary);
  }

  .font-option.selected {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
    box-shadow: inset 0 0 0 1px var(--color-primary);
  }

  .font-preview {
    font-size: var(--text-3xl);
    line-height: var(--leading-none);
    color: var(--color-text);
    /* Normalize visual size across families by x-height so the Literata
       preview matches the others — see AppearanceToolbar. */
    font-size-adjust: 0.52;
  }

  .font-label {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .font-option.selected .font-label {
    color: var(--color-primary);
  }

  .font-size-control {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
  }

  .size-step {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.75rem;
    height: 2.5rem;
    background: var(--color-bg);
    border: none;
    cursor: pointer;
    color: var(--color-text);
    transition: background-color 0.15s ease;
  }

  .size-step:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .size-step:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .size-glyph {
    line-height: var(--leading-none);
    font-weight: var(--weight-semibold);
  }

  .size-glyph-sm {
    font-size: var(--text-md);
  }

  .size-glyph-lg {
    font-size: var(--text-2xl);
  }

  .size-readout {
    min-width: 3.5rem;
    align-self: stretch;
    display: flex;
    align-items: center;
    justify-content: center;
    border-left: 1px solid var(--color-border);
    border-right: 1px solid var(--color-border);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    font-variant-numeric: tabular-nums;
  }

  .size-readout small {
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    margin-left: 0.1rem;
  }

  /* The sample sits on the reading surface itself: Surface, not Sunken, at
     the reading line-height, so it looks like an article and not a widget. */
  .type-sample {
    margin: 0;
    line-height: 1.8;
    color: var(--color-text);
    font-size-adjust: 0.52;
  }

  /* A segmented control: one pill track, the selection a raised tint. */
  .segmented {
    display: inline-flex;
    padding: 2px;
    border-radius: 8px;
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
  }

  .segment {
    padding: 0.375rem 0.875rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .segment:hover:not(.selected) {
    color: var(--color-text);
  }

  .segment.selected {
    background: var(--color-bg);
    color: var(--color-primary);
    box-shadow: 0 0 0 1px var(--color-border);
  }

  /* ── Library & privacy ────────────────────────────────────── */
  .vis-overview {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .vis-overview li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
  }

  .vis-overview li + li {
    border-top: 1px solid var(--color-border);
  }

  .vis-overview a {
    font-size: var(--text-lg);
    color: var(--color-text);
    text-decoration: none;
  }

  .vis-overview a:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .vis-overview + .row {
    border-top: 1px solid var(--color-border);
  }

  /* Visibility badge. Neutral = private (only you); amber = public (anyone can
     see it). Never blue — blue is reserved for interaction (One Blue). The
     icon carries the same meaning, so colour is never the only signal. */
  .vis-badge {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .vis-badge.public {
    background: color-mix(in srgb, var(--color-warning) 16%, var(--color-bg));
    color: color-mix(in srgb, var(--color-warning) 70%, var(--color-text));
  }

  .quiet-footer {
    padding-top: 0.625rem;
    padding-bottom: 0.625rem;
  }

  .pds-link {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    text-decoration: none;
  }

  .pds-link:hover {
    text-decoration: underline;
  }

  .sync-status {
    margin-top: 0.875rem;
    padding: 0.75rem;
    background: var(--color-bg-secondary);
    border-radius: 6px;
  }

  /* The automatic state is the headline: it's what's actually true most of the
     time, and burying it under a "Sync Now" button is what taught readers the
     feed list only moves when they push it. */
  .sync-live {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    margin: 0;
    font-size: var(--text-md);
    color: var(--color-text);
  }

  .sync-live :global(svg) {
    flex-shrink: 0;
    margin-top: 0.15rem;
    color: var(--color-success);
  }

  /* Pending work is a normal, self-clearing state, not a failure — it gets the
     secondary tone rather than the error red. */
  .sync-pending :global(svg) {
    color: var(--color-text-secondary);
  }

  /* The manual check is a repair tool, so it sits below the divider as
     secondary chrome rather than the primary thing to do here. */
  .sync-recheck {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--color-border);
  }

  .sync-time,
  .sync-recheck-hint {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .sync-warnings {
    margin-top: 0.75rem;
  }

  .sync-warning {
    color: var(--color-text-secondary);
    font-size: var(--text-md);
    margin: 0 0 0.25rem;
  }

  /* ── Linkblog ─────────────────────────────────────────────── */
  /* Label and explanation on the left, the select on the right; on a phone
     the select drops under its explanation at full width. */
  .field-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.625rem 1rem;
    align-items: start;
  }

  /* Sized to its longest option, so a choice is never cut off mid-word. */
  .field-row select {
    width: auto;
    min-width: 12rem;
    max-width: 100%;
  }

  @media (max-width: 640px) {
    .field-row {
      grid-template-columns: minmax(0, 1fr);
    }

    .field-row select {
      width: 100%;
    }
  }

  .field {
    width: 100%;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
    box-sizing: border-box;
  }

  .field:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px var(--color-sidebar-active);
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .field {
      font-size: 1rem;
    }
  }

  textarea.field {
    resize: vertical;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .form-field label {
    display: block;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    margin-bottom: 0.375rem;
    color: var(--color-text-secondary);
  }

  .danger-panel {
    border-color: color-mix(in srgb, var(--color-error) 35%, var(--color-border));
  }

  /* ── Save from anywhere ───────────────────────────────────── */
  .disclosure {
    margin-top: 0.875rem;
  }

  .disclosure summary {
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
  }

  .disclosure summary + * {
    margin-top: 0.75rem;
  }

  .bookmarklet-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }

  .bookmarklet {
    display: inline-flex;
    align-items: center;
    padding: 0.45rem 0.85rem;
    border: 1px dashed var(--color-primary);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-primary);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    text-decoration: none;
    cursor: grab;
  }

  .bookmarklet:active {
    cursor: grabbing;
  }

  .shortcut-steps ol {
    margin: 0.75rem 0 0;
    padding-left: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: var(--text-md);
    color: var(--color-text);
  }

  .shortcut-steps code {
    font-family: var(--font-mono, monospace);
    font-size: 0.9em;
    background: var(--color-bg-secondary);
    padding: 0.05em 0.3em;
    border-radius: 4px;
    word-break: break-all;
  }

  /* ── About ────────────────────────────────────────────────── */
  .about-text {
    margin: 0;
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    color: var(--color-text);
  }

  .about-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem 1.25rem;
    margin-top: 0.875rem;
    font-size: var(--text-md);
  }

  .about-links a {
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .about-links a:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  @media (prefers-reduced-motion: reduce) {
    .section-nav a,
    .font-option,
    .size-step,
    .segment,
    .limit-bar-fill {
      transition: none;
    }
  }
</style>
