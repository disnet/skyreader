<script lang="ts">
	import { profileService } from '$lib/services/profiles';
	import type { BlueskyProfile } from '$lib/types';

	let { did }: { did: string } = $props();

	let profile = $state<BlueskyProfile | null>(null);

	$effect(() => {
		profileService.getProfile(did).then((p) => {
			profile = p;
		});
	});
</script>

@{profile?.handle || did}
