// The page is server-rendered (unfurls and search engines get finished HTML) and
// then hydrates: a still-looking page re-asks in the background (invalidateAll,
// see +page.svelte) and fills in as lanes arrive, and the paste box and links
// between link pages navigate without a full reload. Without JavaScript the
// <noscript> meta refresh does the re-asking instead.
export const csr = true;
