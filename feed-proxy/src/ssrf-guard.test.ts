import { describe, expect, it, afterEach, spyOn } from 'bun:test';
import {
  assertPublicUrl,
  isPrivateAddress,
  safeFetch,
  SsrfBlockedError,
  __setDnsLookupForTests,
} from './ssrf-guard';

afterEach(() => {
  __setDnsLookupForTests(null);
});

describe('isPrivateAddress', () => {
  it('flags private/loopback/link-local/metadata IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34']) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  it('flags private/loopback IPv6 incl. IPv4-mapped and Fly ULA', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fdaa:0:1::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('gopher://x/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('rejects embedded credentials', async () => {
    await expect(assertPublicUrl('http://user:pass@example.com/')).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it('rejects literal private/metadata hosts without DNS', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(
      assertPublicUrl('http://169.254.169.254/latest/meta-data/')
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('http://[::1]/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('allows a literal public IP', async () => {
    await expect(assertPublicUrl('https://1.1.1.1/')).resolves.toBeUndefined();
  });

  it('rejects a hostname that resolves to a private address', async () => {
    __setDnsLookupForTests(async () => [{ address: '10.0.0.5' }]);
    await expect(assertPublicUrl('https://evil.internal/')).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it('rejects when ANY resolved address is private (DNS rebinding-ish)', async () => {
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }]);
    await expect(assertPublicUrl('https://mixed.example/')).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it('allows a hostname that resolves to a public address', async () => {
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    await expect(assertPublicUrl('https://good.example/')).resolves.toBeUndefined();
  });
});

describe('safeFetch', () => {
  let fetchMock: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchMock?.mockRestore();
    fetchMock = undefined;
  });

  it('blocks a redirect that lands on an internal address', async () => {
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
    }) as unknown as typeof fetch);

    await expect(safeFetch('https://good.example/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('follows a redirect to another public host and returns the final response', async () => {
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    let call = 0;
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      call++;
      if (call === 1) {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://other.example/final' },
        });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch);

    const res = await safeFetch('https://good.example/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(call).toBe(2);
  });

  it('rejects a blocked initial scheme before fetching', async () => {
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return new Response('should not happen');
    }) as unknown as typeof fetch);

    await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});
