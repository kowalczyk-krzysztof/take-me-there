import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertConsent,
  buildGuidePrompt,
  buildIdentifyMessages,
  formatSignalsForPrompt,
  getActiveProvider,
  getProvider,
  hasConsented,
  loadSettings,
  saveSettings,
  sanitizePromptHint,
  setConsented,
  type ExtensionSettings,
} from './index';
import { installChromeMock, uninstallChromeMock } from '../test/chrome_mock';
import type { PageSignals } from '../types';

const validSignals = (): PageSignals => {
  return {
    imgFound: true,
    alt: 'Blue domes',
    imgTitle: '',
    figcaption: 'Caldera view',
    nearestHeading: 'Getting there',
    nearestParagraph: '',
    ogTitle: '',
    ogDescription: '',
    ogSiteName: 'TravelBlog',
    docTitle: 'Santorini guide',
    metaDescription: '',
    canonical: 'https://example.com/guide',
    pageHost: 'example.com',
    urlSlug: 'santorini guide',
    imgFileSlug: 'oia',
    jsonLd: [],
  };
};

const DEFAULTS: ExtensionSettings = {
  activeProviderId: 'muse',
  openaiCompat: { baseURL: '', model: '', structuredOutput: 'json_object' },
  imageOnly: false,
  sessionOnly: false,
};

beforeEach(() => {
  installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('sanitizePromptHint', () => {
  it('strips control characters and collapses whitespace', () => {
    const nul = String.fromCharCode(0);
    const us = String.fromCharCode(31);
    const del = String.fromCharCode(127);
    expect(sanitizePromptHint(`a${nul}b${us}c${del}d`)).toBe('a b c d');
    const nl = String.fromCharCode(10);
    const tab = String.fromCharCode(9);
    expect(sanitizePromptHint(`x${nl}${nl}y${tab}z`)).toBe('x y z');
    expect(sanitizePromptHint('  padded  ')).toBe('padded');
  });

  it('truncates to the limit', () => {
    expect(sanitizePromptHint('z'.repeat(100))).toHaveLength(80);
    expect(sanitizePromptHint('abcdef', 3)).toBe('abc');
  });
});

describe('prompt builders', () => {
  it('formats signals with labels and skips empties', () => {
    const text = formatSignalsForPrompt(validSignals(), false);
    expect(text).toContain('page title: Santorini guide');
    expect(text).toContain('image caption: Caldera view');
    expect(text).not.toContain('nearby text');
    expect(text).not.toContain('undefined');
  });

  it('withholds page text in image-only mode and handles empty signals', () => {
    expect(formatSignalsForPrompt(validSignals(), true)).toBe(
      '(page text withheld by the user setting)',
    );
    expect(
      formatSignalsForPrompt(
        {
          ...validSignals(),
          alt: '',
          figcaption: '',
          nearestHeading: '',
          ogSiteName: '',
          docTitle: '',
          urlSlug: '',
          imgFileSlug: '',
        },
        false,
      ),
    ).toBe('(no page signals)');
  });

  it('caps listed places at three', () => {
    const signals = validSignals();
    signals.jsonLd = [1, 2, 3, 4].map((n) => ({
      types: ['City'],
      name: `Place${n}`,
      locality: '',
      country: '',
      lat: null,
      lon: null,
    }));
    const text = formatSignalsForPrompt(signals, false);
    expect(text).toContain('Place3');
    expect(text).not.toContain('Place4');
  });

  it('builds the nested image message shape', () => {
    const [developer, user] = buildIdentifyMessages({
      signalsText: 'page title: X',
      imageUrl: 'https://cdn.example.com/oia.jpg',
      insist: false,
    });
    expect(developer.role).toBe('developer');
    expect(user.role).toBe('user');
    expect(user.content).toEqual([
      { type: 'text', text: expect.stringContaining('PAGE SIGNALS') },
      {
        type: 'image_url',
        image_url: { url: 'https://cdn.example.com/oia.jpg' },
      },
    ]);
  });

  it('builds text-only messages with insist, rejected, and reminder variants', () => {
    const [, user] = buildIdentifyMessages({
      signalsText: 'signals',
      imageUrl: null,
      insist: true,
      rejectedPlace: 'Paris',
      strictReminder: true,
    });
    expect(typeof user.content).toBe('string');
    const text = user.content as string;
    expect(text).toContain('NOT Paris');
    expect(text).toContain('user confirms');
    expect(text).toContain('ONLY JSON');
  });

  it('builds the guide prompt with an optional language', () => {
    expect(buildGuidePrompt('Oia, Greece')).toContain('Oia, Greece');
    expect(buildGuidePrompt('Oia, Greece', 'de')).toContain('in de');
  });
});

describe('consent gate', () => {
  it('starts unset and flips once', async () => {
    expect(await hasConsented()).toBe(false);
    await expect(assertConsent()).rejects.toMatchObject({ code: 'consent_required' });
    await setConsented();
    expect(await hasConsented()).toBe(true);
    await expect(assertConsent()).resolves.toBeUndefined();
  });
});

describe('settings and registry', () => {
  it('loads defaults from empty or corrupt storage', async () => {
    expect(await loadSettings()).toEqual(DEFAULTS);
  });

  it('merges stored settings over defaults', async () => {
    await saveSettings({ ...DEFAULTS, activeProviderId: 'openai_compat', imageOnly: true });
    expect(await loadSettings()).toEqual({
      ...DEFAULTS,
      activeProviderId: 'openai_compat',
      imageOnly: true,
    });
  });

  it('resolves providers with muse as the fallback', async () => {
    expect(getProvider(DEFAULTS).id).toBe('muse');
    expect(getProvider(DEFAULTS, 'nope').id).toBe('muse');
    const compat = getProvider({ ...DEFAULTS, activeProviderId: 'openai_compat' });
    expect(compat.id).toBe('openai_compat');
    expect(compat.capabilities.webGrounding).toBe(false);
    const active = await getActiveProvider();
    expect(active.provider.id).toBe('muse');
    expect(active.settings).toEqual(DEFAULTS);
  });
});
