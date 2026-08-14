import { getRequestContext } from './request-context';

// Structured logging for the Worker.
//
// Workers Logs indexes the *fields of an object* passed to `console.*` and treats
// a string — even a JSON one — as an opaque message you can only text-match. So
// this emits one object per line: `{ level, event, requestId, route, … }`, which
// makes "every error on route X" and "every line for request Y" queries rather
// than greps. `wrangler tail` prints the same object inline, so local debugging
// doesn't get worse.
//
// Two rules for call sites:
//   1. `event` is a stable, low-cardinality slug (`request`, `cron_run`,
//      `jetstream_poll`) — it's the thing you filter on. Details go in fields.
//   2. Never log a credential. Workers Logs is not a place where redaction can
//      save you; log an id, a length, or a boolean instead.
//
// Existing `console.log` calls are left alone deliberately: converting ~240 leaf
// call sites is churn without payoff. The high-value paths (request summary,
// top-level error, cron, poll cycle) go through here.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

interface LogPayload extends LogFields {
  level: LogLevel;
  event: string;
}

/**
 * Flatten an unknown thrown value into loggable fields. Stacks are kept — this
 * is our own log sink, not a third party — but bounded, since a Workers Logs
 * line has a size limit and a truncated stack still names the throw site.
 */
export function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack?.slice(0, 2000),
    };
  }
  return { errorMessage: String(error) };
}

function emit(level: LogLevel, event: string, fields: LogFields = {}): void {
  const context = getRequestContext();
  const payload: LogPayload = {
    level,
    event,
    ...(context?.requestId ? { requestId: context.requestId } : {}),
    ...(context?.route ? { route: context.route } : {}),
    ...(context?.did ? { did: context.did } : {}),
    ...fields,
  };

  // console.error/warn also route to Workers Logs' level facets, which is what
  // makes "errors only" a one-click filter in the dashboard.
  if (level === 'error') console.error(payload);
  else if (level === 'warn') console.warn(payload);
  else console.log(payload);
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit('debug', event, fields),
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
  error: (event: string, fields?: LogFields) => emit('error', event, fields),
};
