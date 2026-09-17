// One-off: mint the crawler's Web Bot Auth keypair.
//
//   bun run keygen:web-bot-auth
//
// Prints the PRIVATE JWK as a single line of JSON. Store it as the proxy's
// WEB_BOT_AUTH_KEY secret (both Fly apps — staging and prod are the same
// crawler identity) and never commit it. The public half is served from
// api.skyreader.app/.well-known/http-message-signatures-directory once the
// proxy boots with the secret. See feed-proxy/README.md, "Crawler identity".
import { generateWebBotAuthKey } from '../src/web-bot-auth';

const jwk = await generateWebBotAuthKey();
console.error(`keyid (JWK thumbprint): ${jwk.kid}`);
console.error('Private JWK follows on stdout — store it as WEB_BOT_AUTH_KEY:');
console.log(JSON.stringify(jwk));
