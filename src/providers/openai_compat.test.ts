import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatResponse as sharedChatResponse, sseResponse } from '../test/helpers';
import { setConsented, type GuideEvent, type OpenAiCompatSettings } from './index';
import { OpenAiCompatProvider } from './openai_compat';
import { installChromeMock, uninstallChromeMock } from '../test/chrome_mock';

const VALID_PLACE = {
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.8,
  oneLiner: 'Blue domes over the caldera.',
};

const config = (overrides: Partial<OpenAiCompatSettings> = {}): OpenAiCompatSettings => ({
  baseURL: 'https://llm.example.com/v1/',
  model: 'test-model',
  structuredOutput: 'json_object',
  ...overrides,
});

const chatResponse = (place: unknown) =>
  sharedChatResponse(place, { prompt_tokens: 40, completion_tokens: 20 });

const fetchMock = vi.fn();

beforeEach(() => {
  installChromeMock();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  uninstallChromeMock();
});

const input = () => ({
  imageUrl: 'https://cdn.example.com/oia.jpg',
  signalsText: 'page title: X',
  signal: new AbortController().signal,
});

const collect = async (gen: AsyncGenerator<GuideEvent, void, void>): Promise<GuideEvent[]> => {
  const out: GuideEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }

  return out;
};

describe('openai_compat', () => {
  it('identifies with json_object and client-side validation', async () => {
    await setConsented();
    fetchMock.mockResolvedValue(chatResponse(VALID_PLACE));

    const provider = new OpenAiCompatProvider(config());

    const result = await provider.identifyPlace('sk_key', input());
    expect(result.place).toEqual(VALID_PLACE);
    expect(result.usage).toEqual({
      inputTokens: 40,
      outputTokens: 20,
      searchCount: 0,
      flatFeesUsd: 0,
    });
    expect(provider.capabilities.structuredOutput).toBe('json_object');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');

    const body = JSON.parse(init.body as string) as Record<string, any>;
    expect(body.model).toBe('test-model');
    expect(body.prompt_cache_key).toBe('take-me-there');
    expect(body.prompt_cache_retention).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('supports json_schema mode without vendor flags', async () => {
    await setConsented();
    fetchMock.mockResolvedValue(chatResponse(VALID_PLACE));

    const provider = new OpenAiCompatProvider(config({ structuredOutput: 'json_schema' }));
    await provider.identifyPlace('sk_key', input());

    const init = fetchMock.mock.calls[0][1] as RequestInit;

    const body = JSON.parse(init.body as string) as Record<string, any>;
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(body.response_format.json_schema.strict).toBeUndefined();
  });

  it('inherits the text-only image retry', async () => {
    await setConsented();
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));

    const provider = new OpenAiCompatProvider(config());

    const result = await provider.identifyPlace('sk_key', input());
    expect(result.textFallback).toBe(true);
    expect(result.place.confidence).toBe(0.4);
  });

  it('rejects invalid model output after one re-ask', async () => {
    await setConsented();
    fetchMock
      .mockResolvedValueOnce(chatResponse({ ...VALID_PLACE, confidence: 'lots' }))
      .mockResolvedValueOnce(chatResponse({ ...VALID_PLACE, confidence: 'lots' }));

    const provider = new OpenAiCompatProvider(config());
    await expect(provider.identifyPlace('sk_key', input())).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('validates keys and requires configuration', async () => {
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));

    const provider = new OpenAiCompatProvider(config());
    await expect(provider.testKey('sk_key')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('https://llm.example.com/v1/models');

    const unconfigured = new OpenAiCompatProvider(config({ baseURL: '', model: '' }));
    await expect(unconfigured.testKey('sk_key')).rejects.toMatchObject({
      code: 'not_configured',
    });
  });

  it('exposes user-supplied rates or nothing', () => {
    expect(new OpenAiCompatProvider(config()).getRates()).toBeUndefined();
    expect(
      new OpenAiCompatProvider(config({ inputRatePerM: 2, outputRatePerM: 6 })).getRates()
    ).toEqual({ inputUsdPerMTok: 2, outputUsdPerMTok: 6 });
  });

  it('streams guides over chat completions', async () => {
    await setConsented();
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Day 1"}}]}\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
      ])
    );

    const provider = new OpenAiCompatProvider(config());

    const events = await collect(
      provider.streamGuide('sk_key', {
        destination: 'Oia, Greece',
        signal: new AbortController().signal,
      })
    );
    expect(events).toEqual([
      { type: 'delta', text: 'Day 1' },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, searchCount: 0, flatFeesUsd: 0 } },
    ]);
  });

  it('reports repeated cumulative usage blocks once', async () => {
    await setConsented();
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
        'data: {"choices":[{"delta":{"content":" there"}}],"usage":{"prompt_tokens":9,"completion_tokens":5}}\n\ndata: [DONE]\n\n',
      ])
    );

    const provider = new OpenAiCompatProvider(config());

    const events = await collect(
      provider.streamGuide('sk_key', {
        destination: 'Oia, Greece',
        signal: new AbortController().signal,
      })
    );
    expect(events).toEqual([
      { type: 'delta', text: 'Hi' },
      { type: 'delta', text: ' there' },
      {
        type: 'usage',
        usage: { inputTokens: 9, outputTokens: 5, searchCount: 0, flatFeesUsd: 0 },
      },
    ]);
  });

  it('attaches the latest usage when the stream aborts', async () => {
    await setConsented();
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
        'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      ])
    );

    const provider = new OpenAiCompatProvider(config());

    const controller = new AbortController();

    const gen = provider.streamGuide('sk_key', {
      destination: 'Oia, Greece',
      signal: controller.signal,
    });

    const first = await gen.next();
    expect(first.value).toEqual({ type: 'delta', text: 'Hi' });
    controller.abort();
    await expect(gen.next()).rejects.toMatchObject({
      code: 'aborted',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  });

  it('enforces consent on every remote call', async () => {
    const provider = new OpenAiCompatProvider(config());
    await expect(provider.identifyPlace('sk_key', input())).rejects.toMatchObject({
      code: 'consent_required',
    });
    await expect(
      collect(
        provider.streamGuide('sk_key', {
          destination: 'X',
          signal: new AbortController().signal,
        })
      )
    ).rejects.toMatchObject({ code: 'consent_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('compat planItinerary', () => {
  const VALID_PLAN = {
    stops: ['Oia', 'Fira'],
    days: [],
    nightsEach: [{ stop: 'Oia', nights: 1 }],
  };

  const planInput = () => ({
    pins: [
      { name: 'Oia', host: 'example.com' },
      { name: 'Fira', host: 'blog.example' },
    ],
    signal: new AbortController().signal,
  });

  it('uses the configured envelope and validates client-side', async () => {
    await setConsented();
    fetchMock.mockResolvedValue(chatResponse(VALID_PLAN));

    const provider = new OpenAiCompatProvider(config({ structuredOutput: 'json_schema' }));

    const result = await provider.planItinerary('sk_key', planInput());
    expect(result.plan.stops).toEqual(['Oia', 'Fira']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');

    const body = JSON.parse(init.body as string) as Record<string, Record<string, unknown>>;
    expect((body.response_format as Record<string, string>).type).toBe('json_schema');
    expect(body.prompt_cache_key).toBe('take-me-there');
    expect(body.prompt_cache_retention).toBeUndefined();
    expect(body.max_completion_tokens).toBe(4096);
  });

  it('falls back to json_object with the same client validation', async () => {
    await setConsented();
    fetchMock.mockResolvedValue(chatResponse(VALID_PLAN));

    const provider = new OpenAiCompatProvider(config({ structuredOutput: 'json_object' }));

    const result = await provider.planItinerary('sk_key', planInput());
    expect(result.plan.stops).toEqual(['Oia', 'Fira']);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    const body = JSON.parse(init.body as string) as Record<string, Record<string, unknown>>;
    expect((body.response_format as Record<string, string>).type).toBe('json_object');
  });

  it('honors prompt overrides in streamed guides', async () => {
    await setConsented();
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
        '\n',
        'data: [DONE]\n',
        '\n',
      ])
    );

    const provider = new OpenAiCompatProvider(config());

    const events: GuideEvent[] = [];
    for await (const event of provider.streamGuide('sk_key', {
      destination: 'X',
      signal: new AbortController().signal,
      prompt: 'Custom narration prompt.',
    })) {
      events.push(event);
    }
    expect(events.some((event) => event.type === 'delta')).toBe(true);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body as string).toContain('Custom narration prompt.');
  });
});

describe('compat scanPlaces', () => {
  const VALID_BATCH = {
    places: [{ placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 0 }],
  };

  const scanInput = () => ({
    images: [
      {
        url: 'https://cdn.example.com/a.jpg',
        caption: 'Blue domes',
        heading: '',
        width: 800,
        height: 600,
      },
    ],
    signal: new AbortController().signal,
  });

  it('uses the configured envelope for batches', async () => {
    await setConsented();
    fetchMock.mockResolvedValue(chatResponse(VALID_BATCH));

    const provider = new OpenAiCompatProvider(config());

    const result = await provider.scanPlaces('sk_key', scanInput());
    expect(result.places).toHaveLength(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');

    const body = JSON.parse(init.body as string) as Record<string, Record<string, unknown>>;
    expect((body.response_format as Record<string, string>).type).toBe('json_object');
    expect(body.prompt_cache_key).toBe('take-me-there');
    expect(body.prompt_cache_retention).toBeUndefined();
    expect(body.max_completion_tokens).toBe(4096);
  });
});

describe('compat duelPlaces', () => {
  const VALID_DUEL = {
    criteria: [{ criterion: 'Cost', a: 'Pricey sunsets.', b: 'Cheaper stays.' }],
    verdict: 'Pick Oia for views; pick Fira for budget.',
  };

  const duelInput = () => ({
    a: { name: 'Oia', country: 'Greece' },
    b: { name: 'Fira', country: 'Greece' },
    signal: new AbortController().signal,
  });

  it('duels over structured chat with no citations', async () => {
    await setConsented();
    fetchMock.mockResolvedValue(chatResponse(VALID_DUEL));

    const provider = new OpenAiCompatProvider(config({ structuredOutput: 'json_schema' }));

    const result = await provider.duelPlaces('sk_key', duelInput());
    expect(result.criteria).toHaveLength(1);
    expect(result.sources).toEqual([]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');

    const body = JSON.parse(init.body as string) as {
      response_format: { type: string; json_schema: { name: string } };
      prompt_cache_key: string;
    };
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('duel');
    expect(body.prompt_cache_key).toBe('take-me-there');
  });
});

describe('compat findAlternates', () => {
  const VALID_ALTERNATES = {
    alternatives: [
      {
        placeName: 'Fira',
        country: 'Greece',
        why: 'Same caldera, lower prices.',
        bestMonth: 'May',
      },
    ],
  };

  const alternatesInput = () => ({
    placeName: 'Oia',
    city: 'Oia',
    country: 'Greece',
    intent: 'quieter' as const,
    signal: new AbortController().signal,
  });

  it('finds alternates over chat and reports usage', async () => {
    await setConsented();
    fetchMock.mockResolvedValue(chatResponse(VALID_ALTERNATES));

    const provider = new OpenAiCompatProvider(config());

    const result = await provider.findAlternates('sk_key', alternatesInput());
    expect(result.alternatives).toHaveLength(1);
    expect(result.usage).toEqual({
      inputTokens: 40,
      outputTokens: 20,
      searchCount: 0,
      flatFeesUsd: 0,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body as string).toContain('smaller crowds');
  });
});

describe('compat segmentLandmark', () => {
  it('throws not_configured without fetching', async () => {
    await setConsented();

    const provider = new OpenAiCompatProvider(config());
    await expect(
      provider.segmentLandmark('sk_key', {
        imageDataUrl: 'data:image/jpeg;base64,AAA',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
