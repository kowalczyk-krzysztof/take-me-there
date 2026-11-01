import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  STRICT_REMINDER,
  assertConsent,
  buildAlternatesMessages,
  buildIdentifyMessages,
  extractChatJson,
  extractResponsesStructured,
  extractResponsesText,
  extractResponsesUsage,
  formatSignalsForPrompt,
  getActiveProviderStrict,
  getProvider,
  hasConsented,
  loadSettings,
  parseAlternatesContent,
  emptyUsage,
  allowsImageMedia,
  allowsVideoMedia,
  readBoundedJson,
  readChatUsage,
  fetchChatCompletion,
  responseError,
  toNetworkError,
  withUsage,
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
    expect(parseAlternatesContent({ alternatives: [] })).toEqual([]);
    expect(parseAlternatesContent({})).toBeUndefined();
    expect(
      parseAlternatesContent({
        alternatives: [{ placeName: '', country: '', why: '', bestMonth: '' }],
      })
    ).toBeUndefined();
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
    expect(extracted?.sources).toEqual([]);
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

  it('collects citation sources and drops unsafe ones', () => {
    const data = {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: '{"verdict":"v"}',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://example.com/caldera',
                  title: 'Caldera guide',
                },
                {
                  type: 'url_citation',
                  url: 'https://example.com/caldera',
                  title: 'Caldera guide repeat',
                },
                { type: 'url_citation', url: 'https://example.org/ferries' },
                { type: 'url_citation', url: 'http://example.net/plain', title: 'Plain' },
                { type: 'other', url: 'https://example.com/other', title: 'Other' },
              ],
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    expect(extractResponsesStructured(data)?.sources).toEqual([
      { title: 'Caldera guide', url: 'https://example.com/caldera' },
      { title: 'example.org', url: 'https://example.org/ferries' },
    ]);
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
    const controller = new AbortController();
    controller.abort();
    localFetch.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(
      fetchChatCompletion('https://x.test/chat', 'k', {}, controller.signal, emptyUsage())
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('maps abort-named failures with a live signal to retryable timeouts', async () => {
    localFetch.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(
      fetchChatCompletion(
        'https://x.test/chat',
        'k',
        {},
        new AbortController().signal,
        emptyUsage()
      )
    ).rejects.toMatchObject({ code: 'network', retryable: true });
  });

  it('maps body-read aborts to typed cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    const res = new Response(
      new ReadableStream({
        start(child) {
          child.error(new DOMException('aborted', 'AbortError'));
        },
      }),
      { status: 200 }
    );

    await expect(
      readBoundedJson(res, emptyUsage(), 'response', controller.signal)
    ).rejects.toMatchObject({ name: 'ProviderError', code: 'aborted', retryable: false });
  });

  it('maps body-read aborts with a live signal to retryable timeouts', async () => {
    const res = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new DOMException('aborted', 'AbortError'));
        },
      }),
      { status: 200 }
    );

    await expect(
      readBoundedJson(res, emptyUsage(), 'response', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'network', retryable: true });
  });

  it('maps body-read failures to typed cancellation when the signal aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const res = new Response(
      new ReadableStream({
        start(child) {
          child.error(new Error('socket reset'));
        },
      }),
      { status: 200 }
    );

    await expect(
      readBoundedJson(res, emptyUsage(), 'response', controller.signal)
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('attaches accumulated usage to mapped failures', async () => {
    const usage = { ...emptyUsage(), inputTokens: 100, outputTokens: 50 };

    const network = toNetworkError(new Error('down'), new AbortController().signal, usage);
    expect(network.usage).toEqual(usage);

    const http = responseError(new Response(null, { status: 500 }), usage);
    expect(http.usage).toEqual(usage);

    const bare = withUsage(responseError(new Response(null, { status: 500 })), undefined);
    expect(bare.usage).toBeUndefined();
  });

  it('extracts response usage without valid text', () => {
    expect(
      extractResponsesUsage({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }],
        usage: { input_tokens: 900, output_tokens: 40 },
      })
    ).toEqual({ inputTokens: 900, outputTokens: 40, cachedInputTokens: 0 });

    expect(extractResponsesUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it('maps body-read failures to retryable network errors', async () => {
    const res = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('socket reset'));
        },
      }),
      { status: 200 }
    );

    await expect(
      readBoundedJson(res, emptyUsage(), 'response', new AbortController().signal)
    ).rejects.toMatchObject({ name: 'ProviderError', code: 'network', retryable: true });
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
    const { local } = installChromeMock();
    await local.set({ settings: { v: 1, settings: { imageOnly: true } } });
    expect(await loadSettings()).toEqual({
      ...DEFAULTS,
      imageOnly: true,
    });
  });

  it('defaults cheap mode off for legacy records without the flag', async () => {
    const { local } = installChromeMock();
    await local.set({
      settings: {
        v: 1,
        settings: { imageOnly: false, sessionOnly: false },
      },
    });
    expect((await loadSettings()).skipWebSearch).toBe(false);
  });

  it('resolves the Muse provider without reading settings', () => {
    expect(getProvider().id).toBe('muse');
  });

  it('strictly resolves the provider with verified settings', async () => {
    const active = await getActiveProviderStrict();
    expect(active.provider.id).toBe('muse');
    expect(active.settings).toEqual(DEFAULTS);
  });
});
