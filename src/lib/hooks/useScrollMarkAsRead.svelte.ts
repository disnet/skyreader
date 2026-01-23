import { onDestroy } from 'svelte';

interface ScrollMarkAsReadParams {
	getArticleElements: () => HTMLElement[];
	enabled: boolean;
	onMarkAsRead: (index: number) => void;
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

		scrollMarkObserver = new IntersectionObserver(
			(entries) => {
				// Only process if scrolling down
				if (scrollDirection !== 'down') return;

				entries.forEach((entry) => {
					// Article left viewport from top (boundingClientRect.top < 0) and is no longer intersecting
					if (!entry.isIntersecting && entry.boundingClientRect.top < 0) {
						const index = parseInt((entry.target as HTMLElement).dataset.index || '-1');
						if (index >= 0) {
							params.onMarkAsRead(index);
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
			if (el) {
				el.dataset.index = String(index);
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
