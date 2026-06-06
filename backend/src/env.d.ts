// Secrets not included in cf-typegen output (defined in .dev.vars / wrangler secrets)
declare namespace Cloudflare {
  interface Env {
    FEED_PROXY_SECRET: string;
    // Public base for users' linkblogs (linkblogs.skyreader.app). A [vars] entry,
    // so cf-typegen also emits it; declared here too for envs typed without it.
    LINKBLOG_PUBLIC_URL?: string;
  }
}
