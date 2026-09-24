// Snapshots of other apps' published permission sets that Skyreader requests by
// `include:`. The PDS resolves the live set from the network at authorization and
// on every refresh; these copies are only used to expand a stored raw `include:`
// locally (services/scope-check.ts) and to pin, in test/oauth-scopes.spec.ts, that
// each set still covers what the feature's gates check.
//
// Resolve the live copy with `goat lex resolve <nsid>`. If a set stops covering a
// collection we write, sessions lose it on their next refresh and the gate's 403
// sends the reader through "Allow access" again, which will keep failing. When
// that happens, drop the feature back to granular scopes in
// FEATURE_PERMISSION_SET_SCOPES.

/** site.standard.authFull, published under `_lexicon.standard.site`. */
export const SITE_STANDARD_AUTH_FULL = {
  id: 'site.standard.authFull',
  main: {
    type: 'permission-set',
    title: 'Standard.site',
    detail: 'Manage your publications, documents, subscriptions, and recommends.',
    permissions: [
      {
        type: 'permission',
        resource: 'repo',
        collection: [
          'site.standard.publication',
          'site.standard.document',
          'site.standard.graph.subscription',
          'site.standard.graph.recommend',
        ],
      },
    ],
  },
} as const;

/** network.cosmik.authFull (Semble), published under `_lexicon.cosmik.network`. */
export const SEMBLE_AUTH_FULL = {
  id: 'network.cosmik.authFull',
  main: {
    type: 'permission-set',
    title: 'Semble',
    detail: 'Full access to Semble features.',
    permissions: [
      {
        type: 'permission',
        resource: 'repo',
        action: ['create', 'update', 'delete'],
        collection: [
          'network.cosmik.card',
          'network.cosmik.collection',
          'network.cosmik.collectionLink',
          'network.cosmik.collectionLinkRemoval',
        ],
      },
    ],
  },
} as const;

/** app.userinput.authBasic, published under `_lexicon.userinput.app`. */
export const USERINPUT_AUTH_BASIC = {
  id: 'app.userinput.authBasic',
  main: {
    type: 'permission-set',
    title: 'user input',
    detail: 'Start discussions, reply, vote, and edit your own posts.',
    permissions: [
      {
        type: 'permission',
        resource: 'repo',
        collection: [
          'app.userinput.discussion',
          'app.userinput.reply',
          'app.userinput.upvote',
          'app.userinput.downvote',
          'app.userinput.edit',
        ],
      },
    ],
  },
} as const;

export const EXTERNAL_PERMISSION_SETS = [
  SITE_STANDARD_AUTH_FULL,
  SEMBLE_AUTH_FULL,
  USERINPUT_AUTH_BASIC,
] as const;
