import { onDestroy } from 'svelte';

interface ScrollMarkAsReadParams {
	getArticleElements: () => HTMLElement[];
	getItemKey: (index: number) => string | undefined;
	enabled: boolean;
	onMarkAsRead: (key: string) => void;
}

/**
 * Hook for scroll-to-mark-as-read functionality.
 * Observes article elements and marks them as read when they scroll past the top of the viewport.
 */
export function useScrollMarkAsRead(params: ScrollMarkAsReadParams) {
	let lastScrollY = 0;
	let scrollDirection: 'up' | 'down' | null = null;
	let scrollMarkObserver: IntersectionObserver | null = null;

	function updateScrollDirection() {
		const currentScrollY = window.scrollY;
		if (currentScrollY > lastScrollY) {
			scrollDirection = 'down';
		} else if (currentScrollY < lastScrollY) {
			scrollDirection = 'up';
		}
		lastScrollY = currentScrollY;
	}

	function setupObserver() {
		// Clean up existing observer
		if (scrollMarkObserver) {
			scrollMarkObserver.disconnect();
			scrollMarkObserver = null;
		}

		if (!params.enabled) return;

		// Reset scroll direction to prevent stale direction from marking items
		// when content changes cause elements to shift above the viewport
		scrollDirection = null;

		scrollMarkObserver = new IntersectionObserver(
			(entries) => {
				// Only process if scrolling down
				if (scrollDirection !== 'down') return;

				entries.forEach((entry) => {
					// Article left viewport from top (boundingClientRect.top < 0) and is no longer intersecting
					if (!entry.isIntersecting && entry.boundingClientRect.top < 0) {
						const key = (entry.target as HTMLElement).dataset.key;
						if (key) {
							params.onMarkAsRead(key);
						}
					}
				});
			},
			{
				root: null, // viewport
				rootMargin: '0px',
				threshold: 0,
			}
		);

		// Observe all article elements
		const elements = params.getArticleElements();
		elements.forEach((el, index) => {
			const key = params.getItemKey(index);
			if (el && key) {
				el.dataset.key = key;
				scrollMarkObserver?.observe(el);
			}
		});
	}

	function init() {
		window.addEventListener('scroll', updateScrollDirection, { passive: true });
		lastScrollY = window.scrollY;
		setupObserver();
	}

	function cleanup() {
		window.removeEventListener('scroll', updateScrollDirection);
		scrollMarkObserver?.disconnect();
		scrollMarkObserver = null;
	}

	// Auto-cleanup on component destroy
	onDestroy(cleanup);

	return {
		init,
		cleanup,
		setupObserver,
	};
}
