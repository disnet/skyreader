// Polar webhook test signer. Polar signs with one of two keys (see
// services/polar.ts): 'polar' (secrets generated before 2026-09-08) uses the
// UTF-8 bytes of the secret string exactly as issued; 'standard' (Standard
// Webhooks, secrets generated on or after it) uses the base64-decode of the
// part after `whsec_`. Either way the signature is
// 'v1,' + base64(HMAC-SHA256(key, `${id}.${ts}.${body}`)).
// Signing for real here means the specs exercise verifyPolarWebhook
// end-to-end instead of mocking it.

export async function signWebhook(
  body: string,
  secret: string,
  id = 'msg_test_1',
  timestamp = Math.floor(Date.now() / 1000),
  scheme: 'polar' | 'standard' = 'polar'
): Promise<Record<string, string>> {
  const keyBytes =
    scheme === 'standard'
      ? Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`)
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(signed)));
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
  };
}
