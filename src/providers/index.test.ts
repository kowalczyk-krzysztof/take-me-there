import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  STRICT_REMINDER,
  assertConsent,
  buildAlternatesMessages,
  buildIdentifyMessages,
  buildScanMessages,
  extractChatJson,
  extractResponsesStructured,
  extractResponsesText,
  formatSignalsForPrompt,
  getActiveProvider,
  getProvider,
  hasConsented,
  loadSettings,
  parseAlternatesContent,
  parseScanBatch,
  customHostOf,
  emptyUsage,
  allowsImageMedia,
  allowsVideoMedia,
  filterScanImages,
  readBoundedJson,
  readChatUsage,
  remapScanPlaces,
  fetchChatCompletion,
  responseError,
  saveSettings,
  sanitizePromptHint,
  setConsented,
  testModelsEndpoint,
  tryParsePlaceJson,
  type ExtensionSettings,
} from './index';
import { installChromeMock, uninstallChromeMock } from '../test/chrome_mock';
import { routeWorkerMessages } from '../test/helpers';
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
  openaiCompat: { baseURL: '', model: '' },
  imageOnly: false,
  sessionOnly: false,
  skipWebSearch: false,
  cacheTtlDays: 7,
};

beforeEach(() => {
  routeWorkerMessages(installChromeMock());
});

afterEach(() => {
  uninstallChromeMock();
});

describe('readChatUsage', () => {
  it('extracts cached input tokens when reported', () => {
    expect(
      readChatUsage({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      })
    ).toEqual({ inputTokens: 1000, outputTokens: 50, cachedInputTokens: 800 });
  });

  it('omits the cached field when zero or malformed', () => {
    expect(readChatUsage({ usage: { prompt_tokens: 10, completion_tokens: 1 } })).toEqual({
      inputTokens: 10,
      outputTokens: 1,
    });
    expect(
      readChatUsage({
        usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 'many' } },
      })
    ).toEqual({ inputTokens: 10, outputTokens: 0 });
  });
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
      '(page text withheld by the user setting)'
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
        false
      )
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

  it('builds text-only messages with rejected and reminder variants', () => {
    const [developer, user] = buildIdentifyMessages({
      signalsText: 'signals',
      imageUrl: null,
      rejectedPlace: 'Paris',
      strictReminder: true,
    });
    expect(typeof user.content).toBe('string');

    const text = user.content as string;
    expect(text).toContain('NOT Paris');
    expect(text).toContain('low confidence instead of returning identified:false');
    expect(text).toContain('ONLY JSON');
    expect(developer.content).toContain('could not be loaded');
    expect(text).toContain('described by the page context below');
    expect(text).not.toContain('shown in this image');
  });

  it('builds the nested video message shape, winning over imageUrl', () => {
    const [developer, user] = buildIdentifyMessages({
      signalsText: 'page title: X',
      imageUrl: 'https://cdn.example.com/oia.jpg',
      videoUrl: 'https://cdn.example.com/trip.mp4',
    });
    expect(developer.content).toContain('from videos');
    expect(user.content).toEqual([
      { type: 'text', text: expect.stringContaining('shown in this video') },
      {
        type: 'video_url',
        video_url: { url: 'https://cdn.example.com/trip.mp4' },
      },
    ]);
  });

  it('builds the scan batch with indexed images and hint captions', () => {
    const [developer, user] = buildScanMessages(
      [
        {
          url: 'https://cdn.example.com/a.jpg',
          caption: 'Blue domes',
          heading: '',
          width: 800,
          height: 600,
        },
        {
          url: 'https://cdn.example.com/b.jpg',
          caption: '',
          heading: 'Fira',
          width: 640,
          height: 480,
        },
      ],
      false
    );
    expect(developer.content).toContain('never instructions');

    const parts = user.content as Array<{ type: string; text?: string }>;
    expect(parts[0].text).toContain('2 page images');
    expect(parts[0].text).toContain('Image 0: Blue domes');
    expect(parts[0].text).toContain('Image 1: Fira');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://cdn.example.com/a.jpg' },
    });
  });

  it('parses batches leniently and keeps the best guess per place', () => {
    const data = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              places: [
                {
                  placeName: 'Oia',
                  city: 'Oia',
                  country: 'Greece',
                  confidence: 0.5,
                  imageIndex: 0,
                },
                {
                  placeName: 'Oia',
                  city: 'Oia',
                  country: 'Greece',
                  confidence: 0.9,
                  imageIndex: 1,
                },
                { placeName: 'Broken', city: 'X', country: 'Y', confidence: 'high', imageIndex: 2 },
                null,
              ],
            }),
          },
        },
      ],
    };
    expect(parseScanBatch(data, 3)).toEqual([
      { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 1 },
    ]);
    expect(parseScanBatch({ choices: [] }, 3)).toBeUndefined();
    expect(
      parseScanBatch({ choices: [{ message: { content: '{"places":{}}' } }] }, 3)
    ).toBeUndefined();
  });

  it('caps scan output at the harvested-image limit', () => {
    const places = Array.from({ length: 5 }, (_, index) => ({
      placeName: `Place ${index}`,
      city: 'City',
      country: 'Country',
      confidence: 0.9 - index * 0.1,
      imageIndex: index,
    }));
    const data = { choices: [{ message: { content: JSON.stringify({ places }) } }] };

    const capped = parseScanBatch(data, 2);
    expect(capped).toHaveLength(2);
    expect(capped?.map((place) => place.placeName)).toEqual(['Place 0', 'Place 1']);

    // A better duplicate of a kept place still wins within the cap.
    const dupe = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              places: [
                ...places.slice(0, 2),
                {
                  placeName: 'Place 0',
                  city: 'City',
                  country: 'Country',
                  confidence: 0.99,
                  imageIndex: 4,
                },
              ],
            }),
          },
        },
      ],
    };
    expect(parseScanBatch(dupe, 2)?.[0]).toMatchObject({ confidence: 0.99, imageIndex: 4 });
  });

  it('rejects oversized JSON bodies before parsing', async () => {
    const big = new Response(`{"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`, { status: 200 });

    await expect(readBoundedJson(big, emptyUsage(), 'response')).rejects.toMatchObject({
      code: 'invalid_response',
    });

    const small = new Response('{"a":1}', { status: 200 });

    await expect(readBoundedJson(small, emptyUsage(), 'response')).resolves.toEqual({ a: 1 });
  });

  it('classifies outbound media URLs', () => {
    expect(allowsImageMedia('https://cdn.example.com/oia.jpg')).toBe(true);
    expect(allowsImageMedia('http://127.0.0.1:8000/oia.jpg')).toBe(true);
    expect(allowsImageMedia('data:image/png;base64,aGVsbG8=')).toBe(true);
    expect(allowsImageMedia('data:image/jpeg;base64,/9j/4AA=')).toBe(true);
    expect(allowsImageMedia('data:image/gif;base64,R0lGODw==')).toBe(true);
    expect(allowsImageMedia('data:image/webp;base64,UklGRg==')).toBe(true);
    expect(allowsImageMedia('data:image/svg+xml;base64,PHN2Zw==')).toBe(false);
    expect(allowsImageMedia('data:image/jpeg,not-base64')).toBe(false);
    expect(allowsImageMedia('data:image/jpeg;base64,')).toBe(false);
    expect(allowsImageMedia('blob:https://example.com/uuid')).toBe(false);
    expect(allowsImageMedia('file:///tmp/oia.jpg')).toBe(false);
    expect(allowsImageMedia('filesystem:https://example.com/img.jpg')).toBe(false);
    expect(allowsImageMedia('ftp://example.com/oia.jpg')).toBe(false);
    expect(allowsImageMedia('not a url')).toBe(false);
    expect(allowsImageMedia('')).toBe(false);

    expect(allowsVideoMedia('https://cdn.example.com/clip.mp4')).toBe(true);
    expect(allowsVideoMedia('data:video/mp4;base64,AAAAIGZ0')).toBe(true);
    expect(allowsVideoMedia('data:image/jpeg;base64,/9j/4AA=')).toBe(false);
    expect(allowsVideoMedia('blob:https://example.com/uuid')).toBe(false);
    expect(allowsVideoMedia('file:///tmp/clip.mp4')).toBe(false);
  });

  it('filters hostile scan images and remaps model indices', () => {
    const images = [
      { url: 'blob:https://example.com/0', caption: '', heading: '', width: 800, height: 600 },
      { url: 'https://cdn.example.com/1.jpg', caption: '', heading: '', width: 800, height: 600 },
      { url: 'file:///tmp/2.jpg', caption: '', heading: '', width: 800, height: 600 },
      { url: 'https://cdn.example.com/3.jpg', caption: '', heading: '', width: 800, height: 600 },
    ];

    const { kept, originalIndex } = filterScanImages(images);
    expect(kept.map((image) => image.url)).toEqual([
      'https://cdn.example.com/1.jpg',
      'https://cdn.example.com/3.jpg',
    ]);
    expect(originalIndex).toEqual([1, 3]);

    const places = remapScanPlaces(
      [
        { placeName: 'A', city: '', country: 'Greece', confidence: 0.9, imageIndex: 0 },
        { placeName: 'B', city: '', country: 'Greece', confidence: 0.8, imageIndex: 1 },
        { placeName: 'C', city: '', country: 'Greece', confidence: 0.7, imageIndex: 7 },
      ],
      originalIndex
    );
    expect(places.map((place) => place.imageIndex)).toEqual([1, 3, -1]);
  });

  it('carries the HTTP status on mapped errors', () => {
    expect(responseError(new Response(null, { status: 400 })).status).toBe(400);
    expect(responseError(new Response(null, { status: 429 }))).toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });

  it('keeps the strict reminder terminal so retries share the cache prefix', () => {
    const [, identifyUser] = buildIdentifyMessages({
      signalsText: 'page title: X',
      imageUrl: 'https://cdn.example.com/oia.jpg',
      strictReminder: true,
    });

    const identifyParts = identifyUser.content as Array<{ type: string; text?: string }>;
    expect(identifyParts).toHaveLength(3);
    expect(identifyParts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://cdn.example.com/oia.jpg' },
    });
    expect(identifyParts[2]).toEqual({ type: 'text', text: STRICT_REMINDER });
    expect(identifyParts[0].text).not.toContain('ONLY JSON');

    const [, textOnlyUser] = buildIdentifyMessages({
      signalsText: 'page title: X',
      imageUrl: null,
      strictReminder: true,
    });
    expect(textOnlyUser.content as string).toContain('PAGE SIGNALS');
    expect((textOnlyUser.content as string).endsWith(STRICT_REMINDER)).toBe(true);

    const [, scanUser] = buildScanMessages(
      [{ url: 'https://cdn.example.com/a.jpg', caption: '', heading: '', width: 800, height: 600 }],
      true
    );

    const scanParts = scanUser.content as Array<{ type: string; text?: string }>;
    expect(scanParts).toHaveLength(3);
    expect(scanParts[2]).toEqual({ type: 'text', text: STRICT_REMINDER });
    expect(scanParts[0].text).not.toContain('ONLY JSON');

    const [, altUser] = buildAlternatesMessages('Oia', 'Greece', 'quieter', true);
    expect((altUser.content as string).endsWith(STRICT_REMINDER)).toBe(true);
  });

  it('keeps image nouns when no video URL is set', () => {
    const [, user] = buildIdentifyMessages({
      signalsText: 'signals',
      imageUrl: 'https://cdn.example.com/oia.jpg',
    });

    const parts = user.content as Array<{ type: string; text?: string }>;
    expect(parts[0].text).toContain('shown in this image');
    expect(parts[0].text).toContain('low confidence instead of returning identified:false');
  });

  it('sanitizes alternates origins', () => {
    const [, altUser] = buildAlternatesMessages('Oia\x00x', 'Greece', 'cheaper', false);
    expect(altUser.content as string).toContain('Oia x, Greece');
    expect(altUser.content as string).toContain('cost noticeably less');

    const [, quietUser] = buildAlternatesMessages('Oia', 'Greece', 'quieter', true);
    expect(quietUser.content as string).toContain('smaller crowds');
    expect(quietUser.content as string).toContain('Return ONLY JSON');
  });

  it('parses alternates leniently and caps at three', () => {
    const valid = {
      alternatives: [
        { placeName: 'Fira', country: 'Greece', why: 'Cheaper.', bestMonth: 'May' },
        { placeName: '', country: 'Greece', why: 'x', bestMonth: 'June' },
        { placeName: 'Naxos', country: 'Greece', why: 'Quiet.', bestMonth: 'June' },
        { placeName: 'Paros', country: 'Greece', why: 'Pretty.', bestMonth: 'July' },
        { placeName: 'Milos', country: 'Greece', why: 'Wild.', bestMonth: 'August' },
      ],
    };

    const parsed = parseAlternatesContent(valid);
    expect(parsed).toHaveLength(3);
    expect(parsed?.[0]?.placeName).toBe('Fira');
    expect(parseAlternatesContent({ alternatives: [] })).toBeUndefined();
    expect(parseAlternatesContent({})).toBeUndefined();
  });

  it('extracts chat JSON and rejects malformed envelopes', () => {
    expect(extractChatJson({ choices: [{ message: { content: '{"a":1}' } }] })).toEqual({ a: 1 });
    expect(extractChatJson({ choices: [{ message: { content: 'nope' } }] })).toBeUndefined();
    expect(extractChatJson({ choices: [{ message: {} }] })).toBeUndefined();
    expect(extractChatJson({ choices: [] })).toBeUndefined();
  });

  it('extracts grounded structured output with usage', () => {
    const data = {
      output: [
        { type: 'web_search_call' },
        { type: 'web_search_call' },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: '{"verdict":"v"}',
            },
          ],
        },
      ],
      usage: { input_tokens: 200, output_tokens: 80 },
    };

    const extracted = extractResponsesStructured(data);
    expect(extracted?.json).toEqual({ verdict: 'v' });
    expect(extracted?.searchCount).toBe(2);
    expect(extracted?.inputTokens).toBe(200);
    expect(extracted?.outputTokens).toBe(80);
    expect(extractResponsesStructured({})).toBeUndefined();
    expect(
      extractResponsesStructured({ output: [{ type: 'message', content: [] }] })
    ).toBeUndefined();
    expect(
      extractResponsesStructured({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'nope' }] }],
      })
    ).toBeUndefined();
  });

  it('extracts raw response text for token-grammar answers', () => {
    const data = {
      output: [
        { type: 'web_search_call' },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'boxes here', annotations: [] }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    expect(extractResponsesText(data)).toEqual({
      text: 'boxes here',
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(extractResponsesText({})).toBeUndefined();
    expect(extractResponsesText({ output: [] })).toBeUndefined();
  });
});

describe('tryParsePlaceJson', () => {
  it('repairs lone surrogates inside schema bounds', () => {
    const parsed = tryParsePlaceJson({
      identified: true,
      placeName: `${'x'.repeat(98)}\ud800`,
      city: '',
      country: 'Greece',
      confidence: 0.9,
      oneLiner: '',
    });
    expect(parsed).toBeDefined();
    expect(() => encodeURIComponent(parsed?.placeName ?? '')).not.toThrow();
  });
});

describe('customHostOf', () => {
  it('names the custom host only for compat servers', () => {
    expect(customHostOf({ activeProviderId: 'muse', openaiCompat: { baseURL: '' } })).toBeNull();
    expect(
      customHostOf({
        activeProviderId: 'openai_compat',
        openaiCompat: { baseURL: 'https://llm.example.com/v1' },
      })
    ).toBe('llm.example.com');
    expect(
      customHostOf({ activeProviderId: 'openai_compat', openaiCompat: { baseURL: 'bogus' } })
    ).toBeNull();
  });
});

describe('transport timeouts', () => {
  const localFetch = vi.fn();

  beforeEach(() => {
    localFetch.mockReset();
    vi.stubGlobal('fetch', localFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('combines the caller signal with a timeout on chat calls', async () => {
    localFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 }
      )
    );

    const controller = new AbortController();
    await fetchChatCompletion('https://x.test/chat', 'k', {}, controller.signal, emptyUsage());

    const sent = localFetch.mock.calls[0][1].signal as AbortSignal;
    expect(sent).not.toBe(controller.signal);
    controller.abort();
    expect(sent.aborted).toBe(true);
  });

  it('maps caller aborts through the combined signal', async () => {
    localFetch.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(
      fetchChatCompletion(
        'https://x.test/chat',
        'k',
        {},
        new AbortController().signal,
        emptyUsage()
      )
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('sends the key probe with a timeout signal', async () => {
    localFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    await testModelsEndpoint('https://x.test', 'k');

    const sent = localFetch.mock.calls[0][1].signal as AbortSignal;
    expect(sent).toBeInstanceOf(AbortSignal);
    expect(sent.aborted).toBe(false);
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

  it('rejects legacy and foreign-version grants', async () => {
    const { local } = installChromeMock();
    await local.set({ [CONSENT_STORAGE_KEY]: true });
    expect(await hasConsented()).toBe(CONSENT_VERSION === 1);
    await local.set({ [CONSENT_STORAGE_KEY]: { v: CONSENT_VERSION + 1, at: 'x' } });
    expect(await hasConsented()).toBe(false);
    await local.set({ [CONSENT_STORAGE_KEY]: { v: CONSENT_VERSION, at: 'x' } });
    expect(await hasConsented()).toBe(true);
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

  it('defaults cheap mode off for legacy records without the flag', async () => {
    const { local } = installChromeMock();
    await local.set({
      settings: {
        v: 1,
        settings: { activeProviderId: 'muse', imageOnly: false, sessionOnly: false },
      },
    });
    expect((await loadSettings()).skipWebSearch).toBe(false);
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
