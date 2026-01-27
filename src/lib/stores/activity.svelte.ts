import { api } from '$lib/services/api';
import type { ReshareActivity } from '$lib/types';

function createActivityStore() {
	let reshareActivity = $state<ReshareActivity[]>([]);
	let isLoading = $state(false);
	let cursor = $state<string | null>(null);
	let hasMore = $state(true);
	let totalReshareCount = $state(0);
	let hasLoadedInitial = $state(false);

	async function loadReshareActivity(loadMore = false) {
		if (isLoading) return;
		if (loadMore && !hasMore) return;

		isLoading = true;

		try {
			const result = await api.getReshareActivity(loadMore ? (cursor ?? undefined) : undefined);

			if (loadMore) {
				reshareActivity = [...reshareActivity, ...result.activity];
			} else {
				reshareActivity = result.activity;
				hasLoadedInitial = true;
			}

			// Calculate total reshare count across all grouped items
			totalReshareCount = reshareActivity.reduce((sum, item) => sum + item.totalCount, 0);

			cursor = result.cursor;
			hasMore = result.cursor !== null;
		} catch (e) {
			console.error('Failed to load reshare activity:', e);
		} finally {
			isLoading = false;
		}
	}

	function reset() {
		reshareActivity = [];
		cursor = null;
		hasMore = true;
		totalReshareCount = 0;
		hasLoadedInitial = false;
	}

	return {
		get reshareActivity() {
			return reshareActivity;
		},
		get isLoading() {
			return isLoading;
		},
		get hasMore() {
			return hasMore;
		},
		get totalReshareCount() {
			return totalReshareCount;
		},
		get hasLoadedInitial() {
			return hasLoadedInitial;
		},
		loadReshareActivity,
		reset,
	};
}

export const activityStore = createActivityStore();
