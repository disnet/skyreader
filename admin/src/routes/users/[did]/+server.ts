import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { updateUserTier } from '$lib/queries/users';

export const POST: RequestHandler = async ({ platform, params, request }) => {
	const db = platform!.env.DB;
	const did = decodeURIComponent(params.did);

	const body = await request.json() as { action: string; tier?: string };

	if (body.action === 'set_tier') {
		const tier = body.tier;
		if (!tier || typeof tier !== 'string') {
			return json({ error: 'tier is required' }, { status: 400 });
		}
		try {
			await updateUserTier(db, did, tier);
			return json({ success: true, tier });
		} catch (e) {
			const message = e instanceof Error ? e.message : 'Failed to update tier';
			return json({ error: message }, { status: 400 });
		}
	}

	return json({ error: 'Unknown action' }, { status: 400 });
};
