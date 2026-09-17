import { describe, expect, it } from 'vitest';
import {
  CHROME_EXTENSION_URL,
  FIREFOX_EXTENSION_URL,
  SAVE_ANYWHERE_LABEL,
  SAVE_ANYWHERE_SETTINGS_URL,
  saveAnywhereLabel,
  saveAnywhereUrl,
} from './saveAnywhere';

const CHROME_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const FIREFOX_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0';

describe('saveAnywhereUrl', () => {
  it('routes desktop Chrome to the Chrome Web Store', () => {
    expect(saveAnywhereUrl(CHROME_USER_AGENT)).toBe(CHROME_EXTENSION_URL);
  });

  it('routes desktop Firefox to Firefox Add-ons', () => {
    expect(saveAnywhereUrl(FIREFOX_USER_AGENT)).toBe(FIREFOX_EXTENSION_URL);
  });

  it.each([
    'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/140.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0',
  ])('routes mobile browsers to the iOS/Android instructions', (userAgent) => {
    expect(saveAnywhereUrl(userAgent)).toBe(SAVE_ANYWHERE_SETTINGS_URL);
  });

  it.each([
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  ])('routes other desktop browsers to the settings instructions', (userAgent) => {
    expect(saveAnywhereUrl(userAgent)).toBe(SAVE_ANYWHERE_SETTINGS_URL);
  });
});

describe('saveAnywhereLabel', () => {
  it('names the Chrome extension action', () => {
    expect(saveAnywhereLabel(CHROME_USER_AGENT)).toBe('Install Chrome extension');
  });

  it('names the Firefox extension action', () => {
    expect(saveAnywhereLabel(FIREFOX_USER_AGENT)).toBe('Install Firefox extension');
  });

  it('keeps the general label when the action opens setup instructions', () => {
    expect(
      saveAnywhereLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
      )
    ).toBe(SAVE_ANYWHERE_LABEL);
  });
});
