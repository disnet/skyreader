import { api } from '$lib/services/api';
import { privateFeedSignal, type PrivateFeedSignal } from '$lib/utils/privateFeed';

/**
 * Should adding this feed stop to ask whether it goes on the PDS? Only when the
 * URL looks private and Atmospheric sync is on: with sync off nothing is
 * published, so there is nothing to warn about. Settings are fetched only for a
 * URL that already looks private, so an ordinary add costs no extra request.
 * If they can't be read, ask anyway: a needless question beats a leaked key.
 */
export async function privateFeedPrompt(feedUrl: string): Promise<PrivateFeedSignal | null> {
  const signal = privateFeedSignal(feedUrl);
  if (!signal) return null;
  try {
    const settings = await api.getSettings();
    return settings.pdsSyncEnabled ? signal : null;
  } catch {
    return signal;
  }
}
