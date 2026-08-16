import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { getConnectedLinkblogAuthors, publicationUri } from '../src/services/linkblog-sync';

// The network-wide registry is a Constellation query over the marker we stamp on
// the `skyreader-links` publication WE create. Connecting an existing publication
// deliberately writes nothing to it — it belongs to its home app — so a user who
// connects before ever sharing would never appear in discovery. Discovery unions
// this local list over the registry to close that.

const CONNECTED = 'did:plc:registry-connected';
const PLAIN = 'did:plc:registry-plain';
const FOREIGN = 'did:plc:registry-foreign';

async function setPublication(did: string, publication: string | null) {
  await env.DB.prepare(
    `INSERT INTO user_settings (user_did, linkblog_publication, created_at, updated_at)
     VALUES (?, ?, unixepoch(), unixepoch())
     ON CONFLICT(user_did) DO UPDATE SET linkblog_publication = excluded.linkblog_publication`
  )
    .bind(did, publication)
    .run();
}

describe('getConnectedLinkblogAuthors', () => {
  beforeEach(async () => {
    for (const did of [CONNECTED, PLAIN, FOREIGN]) {
      await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(did).run();
      await env.DB.prepare(
        'INSERT OR IGNORE INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())'
      )
        .bind(did, `${did.split(':').pop()}.test`, 'https://test.pds.example')
        .run();
    }
  });

  it('lists a user who connected an existing publication', async () => {
    await setPublication(CONNECTED, `at://${CONNECTED}/site.standard.publication/my-leaflet`);
    expect(await getConnectedLinkblogAuthors(env)).toContain(CONNECTED);
  });

  it('skips users on the default publication — the marker already covers them', async () => {
    await setPublication(PLAIN, publicationUri(PLAIN));
    expect(await getConnectedLinkblogAuthors(env)).not.toContain(PLAIN);
  });

  it('skips a stored publication in someone else’s repo', async () => {
    await setPublication(FOREIGN, `at://${CONNECTED}/site.standard.publication/my-leaflet`);
    expect(await getConnectedLinkblogAuthors(env)).not.toContain(FOREIGN);
  });
});
