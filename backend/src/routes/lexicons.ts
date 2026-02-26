// Lexicon schemas - imported statically for Cloudflare Workers
import feedSubscription from '../../lexicons/app/skyreader/feed/subscription.json';
import socialShare from '../../lexicons/app/skyreader/social/share.json';
import socialShareReadPosition from '../../lexicons/app/skyreader/social/shareReadPosition.json';

const lexicons: Record<string, object> = {
  'app/skyreader/feed/subscription.json': feedSubscription,
  'app/skyreader/social/share.json': socialShare,
  'app/skyreader/social/shareReadPosition.json': socialShareReadPosition,
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
