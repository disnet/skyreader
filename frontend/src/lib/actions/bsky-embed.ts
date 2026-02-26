/**
 * Svelte action to hydrate Bluesky post embeds
 * Finds .bsky-post-embed elements and fetches/renders the post content
 *
 * Security: All user content is escaped via escapeHtml() before rendering
 */

interface BskyPost {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };
  record: {
    text: string;
    createdAt: string;
  };
  embed?: {
    $type: string;
    images?: Array<{
      thumb: string;
      fullsize: string;
      alt?: string;
    }>;
  };
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function renderPost(post: BskyPost): string {
  const author = post.author;
  const displayName = author.displayName || author.handle;
  const postUrl = `https://bsky.app/profile/${author.did}/post/${post.uri.split('/').pop()}`;

  let html = `
		<div class="bsky-post" style="border: 1px solid var(--color-border); border-radius: 12px; padding: 16px; margin: 1em 0; background: var(--color-bg-secondary);">
			<a href="${escapeHtml(postUrl)}" target="_blank" rel="noopener" style="text-decoration: none; color: var(--color-text);">
				<div style="display: flex; gap: 12px; margin-bottom: 12px;">
					${author.avatar ? `<img src="${escapeHtml(author.avatar)}" alt="" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover;">` : `<div style="width: 48px; height: 48px; border-radius: 50%; background: var(--color-border);"></div>`}
					<div style="flex: 1; min-width: 0;">
						<div style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(displayName)}</div>
						<div style="color: var(--color-text-secondary); font-size: 0.875em;">@${escapeHtml(author.handle)}</div>
					</div>
					<svg width="20" height="20" viewBox="0 0 600 530" fill="var(--color-text-secondary)" style="flex-shrink: 0;"><path d="m135.72 44.03c66.496 49.921 138.02 151.14 164.28 205.46 26.262-54.316 97.782-155.54 164.28-205.46 47.98-36.021 125.72-63.892 125.72 24.795 0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.3797-3.6904-10.832-3.7077-7.8964-0.0174-2.9357-1.1937 0.51669-3.7077 7.8964-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.26 82.697-152.22-67.108 11.421-142.55-7.4491-163.25-81.433-5.9562-21.282-16.111-152.36-16.111-170.07 0-88.687 77.742-60.816 125.72-24.795z"/></svg>
				</div>
				<div style="white-space: pre-wrap; line-height: 1.5; margin-bottom: 12px;">${escapeHtml(post.record.text)}</div>`;

  // Render images if present
  if (post.embed?.$type === 'app.bsky.embed.images#view' && post.embed.images) {
    const images = post.embed.images;
    const imageCount = images.length;
    const gridStyle =
      imageCount === 1
        ? ''
        : `display: grid; grid-template-columns: repeat(${Math.min(imageCount, 2)}, 1fr); gap: 4px;`;

    html += `<div style="${gridStyle} margin-bottom: 12px; border-radius: 8px; overflow: hidden;">`;
    for (const img of images) {
      html += `<img src="${escapeHtml(img.thumb)}" alt="${escapeHtml(img.alt || '')}" style="width: 100%; height: auto; object-fit: cover; max-height: 300px;">`;
    }
    html += '</div>';
  }

  html += `
				<div style="color: var(--color-text-secondary); font-size: 0.875em;">${formatDate(post.record.createdAt)}</div>
			</a>
		</div>`;

  return html;
}

function renderError(uri: string): string {
  // Convert AT URI to bsky.app URL for fallback link
  const match = uri.match(/at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/(.+)/);
  const url = match ? `https://bsky.app/profile/${match[1]}/post/${match[2]}` : 'https://bsky.app';

  return `
		<div class="bsky-post bsky-post-error" style="border: 1px solid var(--color-border); border-radius: 12px; padding: 16px; margin: 1em 0; background: var(--color-bg-secondary);">
			<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="display: flex; align-items: center; gap: 8px; text-decoration: none; color: var(--color-text-secondary);">
				<svg width="20" height="20" viewBox="0 0 600 530" fill="currentColor"><path d="m135.72 44.03c66.496 49.921 138.02 151.14 164.28 205.46 26.262-54.316 97.782-155.54 164.28-205.46 47.98-36.021 125.72-63.892 125.72 24.795 0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.3797-3.6904-10.832-3.7077-7.8964-0.0174-2.9357-1.1937 0.51669-3.7077 7.8964-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.26 82.697-152.22-67.108 11.421-142.55-7.4491-163.25-81.433-5.9562-21.282-16.111-152.36-16.111-170.07 0-88.687 77.742-60.816 125.72-24.795z"/></svg>
				<span>View post on Bluesky</span>
			</a>
		</div>`;
}

function renderLoading(): string {
  return `
		<div class="bsky-post bsky-post-loading" style="border: 1px solid var(--color-border); border-radius: 12px; padding: 16px; margin: 1em 0; background: var(--color-bg-secondary);">
			<div style="display: flex; align-items: center; gap: 8px; color: var(--color-text-secondary);">
				<svg width="20" height="20" viewBox="0 0 600 530" fill="currentColor"><path d="m135.72 44.03c66.496 49.921 138.02 151.14 164.28 205.46 26.262-54.316 97.782-155.54 164.28-205.46 47.98-36.021 125.72-63.892 125.72 24.795 0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.3797-3.6904-10.832-3.7077-7.8964-0.0174-2.9357-1.1937 0.51669-3.7077 7.8964-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.26 82.697-152.22-67.108 11.421-142.55-7.4491-163.25-81.433-5.9562-21.282-16.111-152.36-16.111-170.07 0-88.687 77.742-60.816 125.72-24.795z"/></svg>
				<span>Loading post...</span>
			</div>
		</div>`;
}

async function fetchPost(uri: string): Promise<BskyPost | null> {
  try {
    const response = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data.posts?.[0] || null;
  } catch {
    return null;
  }
}

async function hydrateEmbed(element: Element): Promise<void> {
  const uri = element.getAttribute('data-uri');
  if (!uri || element.getAttribute('data-hydrated') === 'true') {
    return;
  }

  // Mark as hydrating to prevent duplicate fetches
  element.setAttribute('data-hydrated', 'true');

  // Show loading state
  element.innerHTML = renderLoading();

  // Fetch and render
  const post = await fetchPost(uri);
  if (post) {
    element.innerHTML = renderPost(post);
  } else {
    element.innerHTML = renderError(uri);
  }
}

/**
 * Svelte action to hydrate Bluesky post embeds within a container
 */
export function bskyEmbed(node: HTMLElement) {
  function hydrate() {
    const embeds = node.querySelectorAll('.bsky-post-embed:not([data-hydrated])');
    embeds.forEach((embed) => hydrateEmbed(embed));
  }

  // Initial hydration
  hydrate();

  // Watch for new embeds (e.g., when content changes)
  const observer = new MutationObserver(() => {
    hydrate();
  });

  observer.observe(node, { childList: true, subtree: true });

  return {
    destroy() {
      observer.disconnect();
    },
  };
}
