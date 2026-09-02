import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// /pricing is what people guess; /supporter is the page. Alias by redirect
// rather than rendering here: checkout return URLs, the page's own history
// rewrites, and sign-in returnUrl targets all say /supporter, so one
// canonical URL keeps those simple. The query rides along in case a link
// ever carries one.
export const load: PageLoad = ({ url }) => {
  redirect(307, `/supporter${url.search}`);
};
