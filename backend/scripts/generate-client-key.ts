/**
 * Generate an ES256 key pair for OAuth confidential client authentication.
 *
 * Run with: npx tsx scripts/generate-client-key.ts
 *
 * This script generates a key pair and outputs:
 * 1. The private key JWK to store as CLIENT_SIGNING_KEY secret
 * 2. Instructions for storing the secret via wrangler
 */

async function generateClientKey(): Promise<void> {
  console.log('Generating ES256 key pair for OAuth confidential client...\n');

  // Generate the key pair
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true, // extractable
    ['sign', 'verify']
  );

  // Export as JWK
  const privateKeyJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;
  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;

  // Generate a key ID (kid) from thumbprint
  const thumbprintInput = JSON.stringify({
    crv: publicKeyJwk.crv,
    kty: publicKeyJwk.kty,
    x: publicKeyJwk.x,
    y: publicKeyJwk.y,
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(thumbprintInput));
  const kid = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  // Add kid to the private key JWK
  const privateKeyWithKid = {
    ...privateKeyJwk,
    kid,
  };

  const privateKeyJson = JSON.stringify(privateKeyWithKid);

  console.log('='.repeat(60));
  console.log('PRIVATE KEY (store as CLIENT_SIGNING_KEY secret)');
  console.log('='.repeat(60));
  console.log(privateKeyJson);
  console.log();

  console.log('='.repeat(60));
  console.log('PUBLIC KEY (for reference only)');
  console.log('='.repeat(60));
  console.log(
    JSON.stringify(
      {
        ...publicKeyJwk,
        kid,
        use: 'sig',
        alg: 'ES256',
      },
      null,
      2
    )
  );
  console.log();

  console.log('='.repeat(60));
  console.log('SETUP INSTRUCTIONS');
  console.log('='.repeat(60));
  console.log(`
1. Copy the PRIVATE KEY JSON above (single line)

2. Store the secret in Cloudflare Workers:

   # For production:
   echo '${privateKeyJson}' | npx wrangler secret put CLIENT_SIGNING_KEY

   # For staging (if using separate environment):
   echo '${privateKeyJson}' | npx wrangler secret put CLIENT_SIGNING_KEY --env staging

3. For local development, add to .dev.vars:
   CLIENT_SIGNING_KEY='${privateKeyJson}'

4. Deploy the updated code and verify:
   curl https://api.skyreader.app/.well-known/client-metadata | jq

   The response should include:
   - "token_endpoint_auth_method": "private_key_jwt"
   - "token_endpoint_auth_signing_alg": "ES256"
   - "jwks": { "keys": [...] }

IMPORTANT: Keep the private key secret! Never commit it to version control.
`);
}

generateClientKey().catch(console.error);
