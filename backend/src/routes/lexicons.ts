// Lexicon schemas - imported statically for Cloudflare Workers
import feedSubscription from '../../lexicons/app/skyreader/feed/subscription.json';
import feedSaved from '../../lexicons/app/skyreader/feed/saved.json';
import spaceSavedAccess from '../../lexicons/app/skyreader/space/savedAccess.json';

const lexicons: Record<string, object> = {
  'app/skyreader/feed/subscription.json': feedSubscription,
  // Saves spike (atproto Spaces): the record written into a user's personal
  // saved-space, and the permission set an OAuth client would `include:` to get
  // access to it. Published because a second client can only validate records it
  // can resolve the schema for — but note neither is requested by the live OAuth
  // flow. See docs/plans/SPACES_SAVES_SPIKE.md.
  'app/skyreader/feed/saved.json': feedSaved,
  'app/skyreader/space/savedAccess.json': spaceSavedAccess,
};

export function handleLexicon(request: Request): Response {
  const url = new URL(request.url);
  // Extract path after /.well-known/lexicons/
  const lexiconPath = url.pathname.replace('/.well-known/lexicons/', '');

  const lexicon = lexicons[lexiconPath];
  if (!lexicon) {
    return new Response(JSON.stringify({ error: 'Lexicon not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(lexicon, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
    },
  });
}

export function handleLexiconIndex(): Response {
  const available = Object.keys(lexicons).map((path) => `/.well-known/lexicons/${path}`);
  return new Response(JSON.stringify({ lexicons: available }, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
