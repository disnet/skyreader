// Also posting a linkblog share to Bluesky. Runs after the linkblog post has
// landed, in the background with its own toast, so the drawer closes on the
// share that matters and a Bluesky hiccup can't take the draft down with it.
import { api, ScopeUpgradeError } from '$lib/services/api';
import { permissionToast } from '$lib/services/permissions';
import { toastStore } from '$lib/stores/toast.svelte';
import { planBlueskyPost, type BlueskyPostPlan } from '$lib/utils/blueskyPost';
import { formatQuoteSeed } from '$lib/utils/linkPost';
import { renderTextShot } from '$lib/utils/textShot';
import type { Article, ShareDraftBlock } from '$lib/types';

const ALT_MAX = 2000;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Alt text for a text shot is the passage itself: it's what the image says. */
function altFor(quote: string, title: string | undefined): string {
  const alt = title ? `Quote from “${title}”: ${quote}` : quote;
  return alt.length > ALT_MAX ? `${alt.slice(0, ALT_MAX - 1)}…` : alt;
}

async function uploadShots(plan: BlueskyPostPlan, article: Article) {
  const source = { title: article.title, domain: domainOf(article.url) };
  const images = [];
  for (const quote of plan.shots) {
    const shot = await renderTextShot(quote, source);
    const { blob } = await api.uploadBlueskyImage(shot.blob);
    images.push({
      image: blob,
      alt: altFor(quote, article.title),
      aspectRatio: { width: shot.width, height: shot.height },
    });
  }
  return images;
}

export async function crossPostToBluesky(
  article: Article,
  blocks: ShareDraftBlock[],
  options: { textShots: boolean }
): Promise<boolean> {
  const toastId = toastStore.add('Posting to Bluesky…');
  try {
    let plan = planBlueskyPost(blocks, article.url, options);
    let images: Awaited<ReturnType<typeof uploadShots>> = [];
    if (plan.shots.length > 0) {
      try {
        images = await uploadShots(plan, article);
      } catch (error) {
        // A permission problem is the reader's to fix, not ours to route around.
        if (error instanceof ScopeUpgradeError) throw error;
        // Couldn't draw or upload the images: post with the link card instead.
        console.error('Text shots failed, posting without them:', error);
        plan = planBlueskyPost(blocks, article.url, { textShots: false });
      }
    }
    const created = await api.createBlueskyPost({
      text: plan.text,
      articleUrl: article.url,
      ...(images.length > 0
        ? { linkText: plan.linkText, images }
        : {
            title: article.title,
            // The feed's summary, stripped of its markup (formatQuoteSeed's '> ' dropped).
            description: formatQuoteSeed(article.summary)?.replace(/^>\s*/, ''),
            imageUrl: article.imageUrl,
          }),
    });
    toastStore.update(toastId, 'success', 'Posted to Bluesky', {
      label: 'View',
      href: created.url,
    });
    return true;
  } catch (error) {
    if (error instanceof ScopeUpgradeError) {
      const { message, action } = permissionToast(error, 'bluesky');
      toastStore.update(toastId, 'error', message, action);
    } else {
      console.error('Failed to post to Bluesky:', error);
      toastStore.update(toastId, 'error', 'Shared to your linkblog, but couldn’t post to Bluesky');
    }
    return false;
  }
}
