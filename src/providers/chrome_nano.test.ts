import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock } from '../test/chrome_mock';
import { setConsented } from './index';
import {
  ChromeNanoProvider,
  downloadNanoModel,
  nanoAvailability,
  resetNanoSession,
} from './chrome_nano';

const VALID_PLACE = {
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.7,
  oneLiner: 'Blue domes over the caldera.',
};

interface FakeSession {
  prompt: ReturnType<typeof vi.fn>;
  promptStreaming: ReturnType<typeof vi.fn>;
  clone: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

const makeSession = (overrides: Partial<FakeSession> = {}): FakeSession => ({
  prompt: vi.fn().mockResolvedValue(JSON.stringify(VALID_PLACE)),
  promptStreaming: vi.fn().mockImplementation(async function* () {
    yield 'Hello ';
    yield 'world';
  }),
  clone: vi.fn(),
  destroy: vi.fn(),
  ...overrides,
});

const installLanguageModel = (availability: string, session: FakeSession) => {
  const clone = session.clone as ReturnType<typeof vi.fn>;
  clone.mockResolvedValue(session);
  const create = vi.fn().mockResolvedValue(session);
  vi.stubGlobal('LanguageModel', {
    availability: vi.fn().mockResolvedValue(availability),
    create,
  });
  return { create };
};

beforeEach(() => {
  installChromeMock();
  resetNanoSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  uninstallChromeMock();
  resetNanoSession();
});

describe('nanoAvailability', () => {
  it('passes availability through and probes with text plus image', async () => {
    const session = makeSession();
    installLanguageModel('downloadable', session);
    expect(await nanoAvailability()).toBe('downloadable');
    const LM = globalThis as unknown as { LanguageModel: { availability: ReturnType<typeof vi.fn> } };
    expect(LM.LanguageModel.availability).toHaveBeenCalledWith({
      expectedInputs: [{ type: 'text' }, { type: 'image' }],
      outputLanguage: 'en',
    });
  });

  it('reports unavailable without the API or on strange answers', async () => {
    expect(await nanoAvailability()).toBe('unavailable');
    const session = makeSession();
    installLanguageModel('eventually', session);
    expect(await nanoAvailability()).toBe('unavailable');
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockRejectedValue(new Error('nope')),
    });
    expect(await nanoAvailability()).toBe('unavailable');
  });
});

describe('downloadNanoModel', () => {
  it('downloads with progress and verifies readiness', async () => {
    const session = makeSession();
    const seen: number[] = [];
    const LM = {
      availability: vi.fn().mockResolvedValue('readily'),
      create: vi.fn().mockImplementation(async (options: { monitor: (m: unknown) => void }) => {
        options.monitor({
          addEventListener: (name: string, fn: (event: { loaded: number }) => void) => {
            expect(name).toBe('downloadprogress');
            fn({ loaded: 0.25 });
            fn({ loaded: 0.75 });
          },
        });
        return session;
      }),
    };
    vi.stubGlobal('LanguageModel', LM);
    await downloadNanoModel((frac) => seen.push(frac));
    expect(seen).toEqual([0.25, 0.75]);
    expect(LM.availability).toHaveBeenCalled();
    expect(LM.create).toHaveBeenCalledWith(expect.objectContaining({ outputLanguage: 'en' }));
  });

  it('throws when the model never becomes ready', async () => {
    const session = makeSession();
    installLanguageModel('downloading', session);
    await expect(downloadNanoModel(() => {})).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('chrome_nano provider', () => {
  const provider = new ChromeNanoProvider();

  it('identifies with the image as supporting evidence', async () => {
    await setConsented();
    const session = makeSession();
    installLanguageModel('readily', session);
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 8, height: 8, close: vi.fn() }));
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return {
          getContext: () => ({ drawImage: vi.fn() }),
          convertToBlob: async () => new Blob(['pixels']),
        };
      }),
    );
    const result = await provider.identifyPlace('', {
      imageUrl: 'data:image/jpeg;base64,/wA=',
      signalsText: 'page title: Santorini guide',
      signal: new AbortController().signal,
    });
    expect(result.place.placeName).toBe('Oia');
    expect(result.textFallback).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, searchCount: 0, flatFeesUsd: 0 });
    const input = session.prompt.mock.calls[0][0] as Array<{
      content: Array<{ type: string; value: unknown }>;
    }>;
    expect(input[0].content.map((part) => part.type)).toEqual(['text', 'image']);
    expect(input[0].content[1].value).toBeInstanceOf(Blob);
    const options = session.prompt.mock.calls[0][1] as { responseConstraint: unknown };
    expect(options.responseConstraint).toMatchObject({ type: 'object' });
    expect(session.clone).toHaveBeenCalledTimes(1);
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('falls back to signals-only when remote bytes are unreachable', async () => {
    const session = makeSession();
    installLanguageModel('readily', session);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('blocked'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await provider.identifyPlace('', {
      imageUrl: 'https://cdn.example.com/oia.jpg',
      signalsText: 'page title: Santorini guide',
      signal: new AbortController().signal,
    });
    expect(result.textFallback).toBe(true);
    expect(session.prompt.mock.calls[0][0]).toEqual(expect.stringContaining('Santorini guide'));
  });

  it('needs neither consent nor a key', async () => {
    const session = makeSession();
    installLanguageModel('readily', session);
    const result = await provider.identifyPlace('', {
      imageUrl: '',
      signalsText: 'page title: Santorini guide',
      signal: new AbortController().signal,
    });
    expect(result.place.identified).toBe(true);
  });

  it('rejects invalid model output and missing models', async () => {
    const session = makeSession({ prompt: vi.fn().mockResolvedValue('not json') });
    installLanguageModel('readily', session);
    await expect(
      provider.identifyPlace('', {
        imageUrl: '',
        signalsText: 'x',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    installLanguageModel('unavailable', makeSession());
    await expect(
      provider.identifyPlace('', {
        imageUrl: '',
        signalsText: 'x',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'not_configured' });
    await expect(provider.testKey('')).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('streams guides with zero usage and runs structured calls', async () => {
    const session = makeSession();
    installLanguageModel('readily', session);
    const events = [];
    for await (const event of provider.streamGuide('', {
      destination: 'Oia, Greece',
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world' },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, searchCount: 0, flatFeesUsd: 0 } },
    ]);
    session.prompt.mockResolvedValue(
      JSON.stringify({
        criteria: [{ criterion: 'Cost', a: 'High.', b: 'Low.' }],
        verdict: 'Pick Oia for views.',
      }),
    );
    const duel = await provider.duelPlaces('', {
      a: { name: 'Oia', country: 'Greece' },
      b: { name: 'Fira', country: 'Greece' },
      signal: new AbortController().signal,
    });
    expect(duel.criteria).toHaveLength(1);
    expect(duel.sources).toEqual([]);
    const lastCall = session.prompt.mock.calls.at(-1) as unknown[];
    const constraint = lastCall[1] as { responseConstraint: unknown };
    expect(constraint.responseConstraint).toMatchObject({ type: 'object' });
    await expect(
      provider.segmentLandmark('', {
        imageDataUrl: 'data:image/jpeg;base64,AAA',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'not_configured' });
    expect(provider.getRates()).toEqual({ inputUsdPerMTok: 0, outputUsdPerMTok: 0 });
    expect(provider.capabilities.onDevice).toBe(true);
  });
});