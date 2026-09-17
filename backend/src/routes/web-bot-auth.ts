// GET /.well-known/http-message-signatures-directory
//
// The feed crawler's Web Bot Auth key directory. The crawler (the Fly feed
// proxy) signs its upstream fetches and names this origin as its
// `Signature-Agent`; a verifier — Cloudflare's Verified Bots check, or any site
// implementing the draft — fetches this path to get the public key. The spec
// requires the directory response to be signed by that same key with a short
// expiry, so it can't be a static file: the proxy signs it per request and this
// route relays it. The private key never leaves the proxy.
//
// See feed-proxy/src/web-bot-auth.ts and feed-proxy/README.md ("Crawler identity").
import type { Env } from '../types';
import { FeedProxyClient, FeedProxyError } from '../services/feed-proxy-client';

// Headers that carry the directory's meaning: the signature pair, the media
// type, and how long a verifier may cache it. Everything else the proxy or Fly's
// edge adds (server, request ids, etc.) is dropped.
const RELAYED_HEADERS = ['Content-Type', 'Cache-Control', 'Signature', 'Signature-Input'];

export async function handleSignatureDirectory(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const proxy = new FeedProxyClient(env);
  let upstream: Response;
  try {
    upstream = await proxy.fetchSignatureDirectory();
  } catch (error) {
    // Unconfigured (404 from the proxy) reads as "no such directory" to a
    // verifier, which is the truth. Anything else is a relay failure.
    if (error instanceof FeedProxyError && error.status === 404) {
      return new Response('Not Found', { status: 404 });
    }
    return new Response('Bad Gateway', { status: 502 });
  }
  const headers = new Headers();
  for (const name of RELAYED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(request.method === 'HEAD' ? null : await upstream.text(), {
    status: 200,
    headers,
  });
}
