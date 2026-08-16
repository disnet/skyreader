import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getLinkblogTargets, publicationUri } from '../src/services/linkblog-sync';

const CONNECTED = 'did:plc:linkblog-connected';
const PLAIN = 'did:plc:linkblog-plain';
const UNKNOWN = 'did:plc:linkblog-unknown';
const HIJACKED = 'did:plc:linkblog-hijacked';

async function setPublication(did: string, publication: string | null, format: string | null) {
  await env.DB.prepare(
    `INSERT INTO user_settings (user_did, linkblog_publication, linkblog_content_format, created_at, updated_at)
     VALUES (?, ?, ?, unixepoch(), unixepoch())
     ON CONFLICT(user_did) DO UPDATE SET linkblog_publication = excluded.linkblog_publication,
       linkblog_content_format = excluded.linkblog_content_format`
  )
    .bind(did, publication, format)
    .run();
}

// Discovery lists many authors at once, so it resolves their linkblog targets in
// one query rather than N. The batch resolver has to agree with the single-DID
// one on every case — including the ones it rejects.
describe('getLinkblogTargets', () => {
  beforeEach(async () => {
    for (const did of [CONNECTED, PLAIN, HIJACKED]) {
      await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(did).run();
      await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(did).run();
      await env.DB.prepare(
        'INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())'
      )
        .bind(did, `${did.split(':').pop()}.test`, 'https://test.pds.example')
        .run();
    }
    await setPublication(
      CONNECTED,
      `at://${CONNECTED}/site.standard.publication/my-leaflet`,
      'pckt'
    );
    await setPublication(PLAIN, null, null);
    // A publication in someone ELSE's repo is not a valid target.
    await setPublication(
      HIJACKED,
      `at://${CONNECTED}/site.standard.publication/my-leaflet`,
      'leaflet'
    );
  });

  it('resolves a connected publication with its content format', async () => {
    const targets = await getLinkblogTargets(env, [CONNECTED]);
    expect(targets.get(CONNECTED)).toEqual({
      siteUri: `at://${CONNECTED}/site.standard.publication/my-leaflet`,
      format: 'pckt',
      external: true,
    });
  });

  it('falls back to the default publication for unset, unknown, and foreign URIs', async () => {
    const targets = await getLinkblogTargets(env, [PLAIN, UNKNOWN, HIJACKED]);
    for (const did of [PLAIN, UNKNOWN, HIJACKED]) {
      expect(targets.get(did)).toEqual({
        siteUri: publicationUri(did),
        format: 'leaflet',
        external: false,
      });
    }
  });

  it('returns an entry for every requested DID, deduped', async () => {
    const targets = await getLinkblogTargets(env, [CONNECTED, CONNECTED, PLAIN]);
    expect([...targets.keys()].sort()).toEqual([CONNECTED, PLAIN].sort());
  });

  it('is empty for an empty request', async () => {
    expect((await getLinkblogTargets(env, [])).size).toBe(0);
  });
});
