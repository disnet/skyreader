// Standard-webhooks test signer, matching Polar's key semantics: the HMAC key
// is the UTF-8 bytes of the secret string exactly as issued (Polar's own
// validateEvent never strips or base64-decodes a whsec_ prefix — see
// services/polar.ts), and the signature is
// 'v1,' + base64(HMAC-SHA256(key, `${id}.${ts}.${body}`)).
// Signing for real here means the specs exercise verifyPolarWebhook
// end-to-end instead of mocking it.

export async function signWebhook(
  body: string,
  secret: string,
  id = 'msg_test_1',
  timestamp = Math.floor(Date.now() / 1000)
): Promise<Record<string, string>> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
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
