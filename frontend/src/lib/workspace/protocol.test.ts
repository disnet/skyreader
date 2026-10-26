import { describe, it, expect } from 'vitest';
import { PROTO, cleanItem, collectionOf, isRecordUri, parseShellMessage, repoOf } from './protocol';

const DID = 'did:plc:abc123';
const DOC = `at://${DID}/site.standard.document/3kabc`;

describe('parseShellMessage', () => {
  it('drops traffic that is not the protocol', () => {
    expect(parseShellMessage(null)).toBeNull();
    expect(parseShellMessage({ type: 'switch' })).toBeNull();
    expect(parseShellMessage({ proto: 'other/1', type: 'sign-out', did: DID })).toBeNull();
    expect(parseShellMessage({ proto: PROTO, type: 'unknown' })).toBeNull();
  });

  it('takes switch and sign-out', () => {
    expect(
      parseShellMessage({ proto: PROTO, type: 'switch', account: { did: DID, handle: 'a.test' } })
    ).toEqual({ type: 'switch', account: { did: DID, handle: 'a.test' } });
    expect(parseShellMessage({ proto: PROTO, type: 'sign-out', did: DID })).toEqual({
      type: 'sign-out',
      did: DID,
    });
    expect(parseShellMessage({ proto: PROTO, type: 'sign-out', did: 'nope' })).toBeNull();
  });

  it('takes open with an optional account', () => {
    expect(parseShellMessage({ proto: PROTO, type: 'open', uri: DOC })).toEqual({
      type: 'open',
      uri: DOC,
      account: undefined,
    });
    expect(parseShellMessage({ proto: PROTO, type: 'open', uri: 'https://x.test' })).toBeNull();
    expect(
      parseShellMessage({ proto: PROTO, type: 'open', uri: DOC, account: { did: 'x' } })
    ).toBeNull();
  });

  it('takes perform only with a well-formed item', () => {
    const item = { title: 'A page', url: 'https://example.com/a' };
    expect(parseShellMessage({ proto: PROTO, type: 'perform', action: 'save', item })).toEqual({
      type: 'perform',
      action: 'save',
      item,
      account: undefined,
    });
    for (const bad of [
      { url: 'https://example.com' },
      { title: 'x', url: 'javascript:alert(1)' },
      { title: 'x', uri: 'https://example.com' },
      { title: 'x', text: 3 },
    ]) {
      expect(
        parseShellMessage({ proto: PROTO, type: 'perform', action: 'save', item: bad })
      ).toBeNull();
    }
  });

  it('takes context-query with an optional did', () => {
    const item = { title: 'A', uri: DOC };
    expect(
      parseShellMessage({ proto: PROTO, type: 'context-query', query: 'q1', item, did: DID })
    ).toEqual({ type: 'context-query', query: 'q1', item, did: DID });
    expect(parseShellMessage({ proto: PROTO, type: 'context-query', query: 1, item })).toBeNull();
  });
});

describe('uri parts', () => {
  it('reads the repo and collection', () => {
    expect(collectionOf(DOC)).toBe('site.standard.document');
    expect(collectionOf(`at://${DID}`)).toBeNull();
    expect(repoOf(DOC)).toBe(DID);
  });

  it('knows a record uri from a collection or a handle repo', () => {
    expect(isRecordUri(DOC)).toBe(true);
    expect(isRecordUri(`at://${DID}/site.standard.publication`)).toBe(false);
    expect(isRecordUri('at://alice.test/site.standard.document/3kabc')).toBe(false);
  });
});

describe('cleanItem', () => {
  it('keeps only fields the shell will take', () => {
    expect(cleanItem({ title: 'T', uri: 'not-a-uri', url: 'mailto:a@b.test', text: '' })).toEqual({
      title: 'T',
    });
    expect(cleanItem({ title: 'T', uri: DOC, url: 'https://x.test/', text: 'q' })).toEqual({
      title: 'T',
      uri: DOC,
      url: 'https://x.test/',
      text: 'q',
    });
  });
});
