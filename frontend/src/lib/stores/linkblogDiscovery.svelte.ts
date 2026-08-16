import { api } from '$lib/services/api';
import { fetchAllDocuments } from '$lib/services/feedFetcher';
import { subscriptionsStore } from './subscriptions.svelte';
import type { LinkblogPerson } from '$lib/types';

/**
 * Linkblog discovery (Phase 6) — find people with a Skyreader linkblog and
 * subscribe to them.
 *
 *  - `friends`: people you follow on Bluesky who have a linkblog (onboarding).
 *  - `people`: the whole registry, friends-first, for the /discover surface.
 *
 * Both are fetched lazily and cached for the session (results change slowly);
 * pass `force` to refetch. Subscribing reuses the normal `atproto.documents`
 * subscription path scoped to the person's publication.
 */
function createLinkblogDiscoveryStore() {
  let friends = $state<LinkblogPerson[]>([]);
  let people = $state<LinkblogPerson[]>([]);
  let friendsLoaded = $state(false);
  let peopleLoaded = $state(false);
  let loadingFriends = $state(false);
  let loadingPeople = $state(false);
  let error = $state<string | null>(null);

  async function loadFriends(force = false): Promise<void> {
    if (loadingFriends || (friendsLoaded && !force)) return;
    loadingFriends = true;
    error = null;
    try {
      friends = (await api.getLinkblogFriends()).people;
      friendsLoaded = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load linkblogs';
    } finally {
      loadingFriends = false;
    }
  }

  async function loadDiscover(force = false): Promise<void> {
    if (loadingPeople || (peopleLoaded && !force)) return;
    loadingPeople = true;
    error = null;
    try {
      people = (await api.getLinkblogDiscover()).people;
      peopleLoaded = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load linkblogs';
    } finally {
      loadingPeople = false;
    }
  }

  // Subscribe to a person's linkblog: an `atproto.documents` stream scoped to
  // their `skyreader-links` publication. Mirrors the sources page's
  // subscribePublication, with the avatar carried over as the source icon.
  async function subscribe(person: LinkblogPerson): Promise<void> {
    const name = person.displayName?.trim() || (person.handle ? `@${person.handle}` : 'Linkblog');
    const id = await subscriptionsStore.add(person.publicationUri, `${name}'s links`, {
      sourceType: 'atproto.documents',
      subjectDid: person.did,
      feedUrl: person.publicationUri,
      // Omitted when the author turned their Skyreader page off: storing a URL
      // that 404s outlives the moment, and the subscription works without one.
      siteUrl: person.blogUrl ?? undefined,
    });
    if (person.avatar) {
      await subscriptionsStore.updateLocal(id, {
        customIconUrl: person.avatar,
      });
    }
    // Fetch this linkblog's documents now so its feed isn't empty until the next
    // full refresh (also refreshed on the regular cycle).
    void fetchAllDocuments(subscriptionsStore.subscriptions);
  }

  return {
    get friends() {
      return friends;
    },
    get people() {
      return people;
    },
    get friendsLoaded() {
      return friendsLoaded;
    },
    get peopleLoaded() {
      return peopleLoaded;
    },
    get loadingFriends() {
      return loadingFriends;
    },
    get loadingPeople() {
      return loadingPeople;
    },
    get error() {
      return error;
    },
    loadFriends,
    loadDiscover,
    subscribe,
  };
}

export const linkblogDiscoveryStore = createLinkblogDiscoveryStore();
