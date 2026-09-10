import { describe, it, expect } from 'vitest';
import { docsOriginFor } from './docs';

describe('docsOriginFor', () => {
  it('maps production to the docs subdomain', () => {
    expect(docsOriginFor('skyreader.app')).toBe('https://docs.skyreader.app');
  });

  it('maps every staging flavor to staging docs', () => {
    expect(docsOriginFor('staging.skyreader.app')).toBe('https://staging-docs.skyreader.app');
    expect(docsOriginFor('staging-prod.skyreader.app')).toBe('https://staging-docs.skyreader.app');
  });

  it('maps local dev to the Astro dev server', () => {
    expect(docsOriginFor('127.0.0.1')).toBe('http://localhost:5176');
    expect(docsOriginFor('localhost')).toBe('http://localhost:5176');
  });

  it('falls back to production docs on an unknown host', () => {
    expect(docsOriginFor('example.com')).toBe('https://docs.skyreader.app');
  });
});
