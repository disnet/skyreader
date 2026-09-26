import type { Env, Session } from '../types';
import { getUserTierLimits } from '../services/user-tier';
import {
  getNewsletterInbox,
  issueNewsletterInbox,
  listBlockedSenders,
  newsletterAddress,
  newsletterDomain,
  unblockSender,
} from '../services/newsletters';

// The reader's newsletter inbox (services/newsletters.ts):
//   GET    /api/newsletters                  - address, entitlement, blocked senders
//   POST   /api/newsletters/address          - issue the address, or { rotate: true }
//   DELETE /api/newsletters/blocked?sender=  - let a blocked sender through again

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleGetNewsletters(env: Env, session: Session): Promise<Response> {
  const domain = newsletterDomain(env);
  const [limits, inbox, blockedSenders] = await Promise.all([
    getUserTierLimits(env, session.did),
    getNewsletterInbox(env, session.did),
    listBlockedSenders(env, session.did),
  ]);
  return json({
    // Off in this environment: no address can receive mail, so none is shown.
    enabled: !!domain,
    entitled: limits.newsletterInbox,
    // Kept visible after a plan lapses so the reader can see which address
    // stopped working; `entitled: false` is what says mail is being refused.
    address: domain && inbox ? newsletterAddress(inbox.token, domain) : null,
    lastReceivedAt: inbox?.lastReceivedAt ? inbox.lastReceivedAt * 1000 : null,
    blockedSenders: blockedSenders.map((b) => ({
      sender: b.sender,
      blockedAt: b.blockedAt * 1000,
    })),
  });
}

export async function handleIssueNewsletterAddress(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const domain = newsletterDomain(env);
  if (!domain) return json({ error: 'Newsletters are not enabled' }, 503);

  const limits = await getUserTierLimits(env, session.did);
  if (!limits.newsletterInbox) {
    return json({ error: 'Newsletters are a Supporter feature', code: 'upgrade_required' }, 403);
  }

  let rotate = false;
  try {
    const body = (await request.json()) as { rotate?: unknown };
    rotate = body?.rotate === true;
  } catch {
    // No body: issue (or return) the address.
  }

  const inbox = await issueNewsletterInbox(env, session.did, rotate);
  return json({ address: newsletterAddress(inbox.token, domain) });
}

export async function handleUnblockNewsletterSender(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405);
  const sender = new URL(request.url).searchParams.get('sender');
  if (!sender) return json({ error: 'sender is required' }, 400);
  await unblockSender(env, session.did, sender);
  return json({ success: true });
}
