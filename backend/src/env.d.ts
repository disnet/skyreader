// Secrets not included in cf-typegen output (defined in .dev.vars / wrangler secrets)
declare namespace Cloudflare {
  interface Env {
    FEED_PROXY_SECRET: string;
  }
}
