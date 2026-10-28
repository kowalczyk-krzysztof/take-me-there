import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatResponse, groundedResponse, sseResponse } from '../test/helpers';
import {
  ProviderError,
  STRICT_REMINDER,
  setConsented,
  type GuideEvent,
  type IdentifyInput,
} from './index';
import { MuseProvider } from './muse';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../test/chrome_mock';

const VALID_PLACE = {
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.9,
  oneLiner: 'Blue domes over the caldera.',
};

const rawChatResponse = (content: string, usage = { prompt_tokens: 100, completion_tokens: 50 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status: 200,
  });

const identifyInput = (overrides: Partial<IdentifyInput> = {}): IdentifyInput => ({
  imageUrl: 'https://cdn.example.com/oia.jpg',
  signalsText: 'page title: Santorini guide',
  signal: new AbortController().signal,
  ...overrides,
});

const collect = async (gen: AsyncGenerator<GuideEvent, void, void>): Promise<GuideEvent[]> => {
  const out: GuideEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }

  return out;
};

let mock: ChromeMock;

const fetchMock = vi.fn();

const provider = new MuseProvider();

beforeEach(() => {
  mock = installChromeMock();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  uninstallChromeMock();
});

const consented = async (): Promise<void> => {
  await setConsented();
};

const requestBody = (callIndex = 0): Record<string, any> => {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;

  return JSON.parse(init.body as string) as Record<string, any>;
};

describe('muse identify', () => {
  it('parses structured output and maps usage', async () => {
    await consented();
    fetchMock.mockResolvedValue(chatResponse(VALID_PLACE));

    const result = await provider.identifyPlace('LLM_key', identifyInput());
    expect(result.place).toEqual(VALID_PLACE);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      searchCount: 0,
      flatFeesUsd: 0,
    });
    expect(result.textFallback).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.meta.ai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer LLM_key');

    const body = requestBody();
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.prompt_cache_key).toBe('take-me-there');
    expect(body.prompt_cache_retention).toBeUndefined();
    expect(body.reasoning_effort).toBe('medium');
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(body.messages[1].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://cdn.example.com/oia.jpg' },
    });
  });

  it('re-asks once on validation failure, then throws with usage attached', async () => {
    await consented();
    fetchMock
      .mockResolvedValueOnce(rawChatResponse('not json {'))
      .mockResolvedValueOnce(rawChatResponse('{"identified":'));

    const failure = await provider.identifyPlace('LLM_key', identifyInput()).then(
      () => null,
      (err: unknown) => err as ProviderError
    );
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure?.code).toBe('invalid_response');
    expect(failure?.retryable).toBe(true);
    expect(failure?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      searchCount: 0,
      flatFeesUsd: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(requestBody(1))).toContain('ONLY JSON');
  });

  it('maps status codes to typed errors', async () => {
    await consented();
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(provider.identifyPlace('LLM_bad', identifyInput())).rejects.toMatchObject({
      code: 'auth',
      retryable: false,
    });
    fetchMock.mockResolvedValue(new Response('slow', { status: 429 }));
    await expect(provider.identifyPlace('LLM_key', identifyInput())).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(provider.identifyPlace('LLM_key', identifyInput())).rejects.toMatchObject({
      code: 'server',
      retryable: true,
    });
  });

  it('retries once text-only on image failure with capped confidence', async () => {
    await consented();
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));

    const result = await provider.identifyPlace('LLM_key', identifyInput());
    expect(result.textFallback).toBe(true);
    expect(result.place.confidence).toBe(0.4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(typeof requestBody(1).messages[1].content).toBe('string');
  });

  it('surfaces the image-400 when the text fallback also fails', async () => {
    await consented();
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(provider.identifyPlace('LLM_key', identifyInput())).rejects.toMatchObject({
      code: 'server',
      status: 400,
    });
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    await expect(provider.identifyPlace('LLM_key', identifyInput())).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('maps network failures and aborts', async () => {
    await consented();
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(provider.identifyPlace('LLM_key', identifyInput())).rejects.toMatchObject({
      code: 'network',
      retryable: true,
    });
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(provider.identifyPlace('LLM_key', identifyInput())).rejects.toMatchObject({
      code: 'aborted',
      retryable: false,
    });
  });

  it('blocks without consent or a key', async () => {
    fetchMock.mockResolvedValue(chatResponse(VALID_PLACE));
    await expect(provider.identifyPlace('LLM_key', identifyInput())).rejects.toMatchObject({
      code: 'consent_required',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await consented();
    await expect(provider.identifyPlace('', identifyInput())).rejects.toMatchObject({
      code: 'no_key',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizes the rejected place on guess-escalating retries', async () => {
    await consented();
    fetchMock.mockResolvedValue(chatResponse(VALID_PLACE));
    await provider.identifyPlace('LLM_key', identifyInput({ rejectedPlace: 'Paris\nHACK' }));

    const body = requestBody();
    expect(body.reasoning_effort).toBe('medium');

    const text = body.messages[1].content[0].text as string;
    expect(text).toContain('NOT Paris HACK.');
    expect(text).toContain('low confidence instead of returning identified:false');
  });

  it('validates keys against the models endpoint', async () => {
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
    await expect(provider.testKey('LLM_key')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.meta.ai/v1/models');
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(provider.testKey('LLM_bad')).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('muse video identify (rung 2)', () => {
  const videoInput = (overrides: Partial<IdentifyInput> = {}): IdentifyInput =>
    identifyInput({
      imageUrl: 'https://cdn.example.com/trip.mp4',
      videoUrl: 'https://cdn.example.com/trip.mp4',
      ...overrides,
    });

  it('sends the video part with the schema constraint', async () => {
    await consented();
    fetchMock.mockResolvedValue(chatResponse(VALID_PLACE));

    const result = await provider.identifyPlace('LLM_key', videoInput());
    expect(result.place).toEqual(VALID_PLACE);
    expect(result.textFallback).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = requestBody();
    expect(body.response_format.type).toBe('json_schema');
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: expect.stringContaining('shown in this video') },
      { type: 'video_url', video_url: { url: 'https://cdn.example.com/trip.mp4' } },
    ]);
  });

  it('falls back to describe-then-normalize when schema x video 400s', async () => {
    await consented();
    fetchMock
      .mockResolvedValueOnce(new Response('schema x video rejected', { status: 400 }))
      .mockResolvedValueOnce(
        rawChatResponse('The video shows the blue domes of Oia, Santorini, Greece.')
      )
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));

    const result = await provider.identifyPlace('LLM_key', videoInput());
    expect(result.place).toEqual(VALID_PLACE);
    expect(result.textFallback).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      searchCount: 0,
      flatFeesUsd: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const describe = requestBody(1);
    expect(describe.response_format).toBeUndefined();
    expect(describe.prompt_cache_key).toBe('take-me-there');
    expect(describe.prompt_cache_retention).toBeUndefined();
    expect(describe.messages[1].content[1]).toEqual({
      type: 'video_url',
      video_url: { url: 'https://cdn.example.com/trip.mp4' },
    });

    const normalize = requestBody(2);
    expect(normalize.response_format.type).toBe('json_schema');
    expect(normalize.prompt_cache_key).toBe('take-me-there');
    expect(normalize.prompt_cache_retention).toBeUndefined();
    expect(normalize.messages[1].content).toContain('VIDEO DESCRIPTION');
    expect(normalize.messages[1].content).toContain('blue domes of Oia');
  });

  it('appends the normalize retry reminder after the description and signals', async () => {
    await consented();
    fetchMock
      .mockResolvedValueOnce(new Response('schema x video rejected', { status: 400 }))
      .mockResolvedValueOnce(
        rawChatResponse('The video shows the blue domes of Oia, Santorini, Greece.')
      )
      .mockResolvedValueOnce(rawChatResponse('not json {'))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));

    const result = await provider.identifyPlace('LLM_key', videoInput());
    expect(result.place).toEqual(VALID_PLACE);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const retry = requestBody(3);
    const content = retry.messages[1].content as string;
    expect(content.indexOf('ONLY JSON')).toBeGreaterThan(content.indexOf('PAGE SIGNALS'));
    expect(content.endsWith(STRICT_REMINDER)).toBe(true);
  });

  it('surfaces the second failure instead of looping fallbacks', async () => {
    await consented();
    fetchMock
      .mockResolvedValueOnce(new Response('schema x video rejected', { status: 400 }))
      .mockResolvedValueOnce(new Response('video rejected', { status: 400 }));
    await expect(provider.identifyPlace('LLM_key', videoInput())).rejects.toMatchObject({
      code: 'server',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second call is the two-step describe (video part, no schema), not
    // the image path's signals-only retry.
    const second = requestBody(1);
    expect(second.response_format).toBeUndefined();
    expect(second.messages[1].content[1].type).toBe('video_url');
  });

  it('does not two-step on non-400 failures', async () => {
    await consented();
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(provider.identifyPlace('LLM_key', videoInput())).rejects.toMatchObject({
      code: 'auth',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('muse streamGuide', () => {
  const RESPONSES_SSE = [
    ': comment line\n',
    '\n',
    'event: keepalive\n',
    'data: ping\n',
    '\n',
    'event: response.web_search_call.searching\n',
    'data: {}\n',
    '\n',
    'event: response.output_text.delta\n',
    'data: {"delta":"Hello "}\n',
    '\n',
    'event: response.output_text.delta\n',
    'data: {"delta":"world"}\n',
    '\n',
    'event: response.output_text.annotation.added\n',
    'data: {"annotation":{"type":"url_citation","url":"https://example.com/a","title":"A"}}\n',
    '\n',
    'event: response.output_text.annotation.added\n',
    'data: {"annotation":{"type":"url_citation","url":"https://example.com/a","title":"A again"}}\n',
    '\n',
    'event: response.web_search_call.completed\n',
    'data: {}\n',
    '\n',
    'event: response.completed\n',
    'data: {"response":{"usage":{"input_tokens":300,"output_tokens":120}}}\n',
    '\n',
  ].join('');

  const input = (overrides = {}) => ({
    destination: 'Oia, Greece',
    signal: new AbortController().signal,
    ...overrides,
  });

  it('attaches partial usage when the stream aborts', async () => {
    await consented();
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: response.web_search_call.completed\n',
        'data: {}\n',
        '\n',
        'event: response.output_text.delta\n',
        'data: {"delta":"Hello"}\n',
        '\n',
      ])
    );

    const controller = new AbortController();

    const gen = provider.streamGuide('LLM_key', input({ signal: controller.signal }));

    const first = await gen.next();
    expect(first.value).toEqual({ type: 'searching' });
    controller.abort();
    await expect(gen.next()).rejects.toMatchObject({
      code: 'aborted',
      usage: { searchCount: 1 },
    });
  });

  it('rejects failed and incomplete responses instead of ending cleanly', async () => {
    await consented();
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: response.failed\n',
        'data: {"response":{"error":{"message":"boom"}}}\n',
        '\n',
      ])
    );
    await expect(collect(provider.streamGuide('LLM_key', input()))).rejects.toMatchObject({
      code: 'server',
    });
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: response.output_text.delta\n',
        'data: {"delta":"partial"}\n',
        '\n',
        'event: response.incomplete\n',
        'data: {"response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n',
        '\n',
      ])
    );
    await expect(collect(provider.streamGuide('LLM_key', input()))).rejects.toMatchObject({
      code: 'invalid_response',
    });
    fetchMock.mockResolvedValue(
      sseResponse(['event: response.completed\n', 'data: {"response":{"status":"failed"}}\n', '\n'])
    );
    await expect(collect(provider.streamGuide('LLM_key', input()))).rejects.toMatchObject({
      code: 'server',
    });
  });

  it('parses grounded responses split across chunk boundaries', async () => {
    await consented();

    const raw = RESPONSES_SSE;
    fetchMock.mockResolvedValue(sseResponse([raw.slice(0, 50), raw.slice(50, 51), raw.slice(51)]));

    const events = await collect(provider.streamGuide('LLM_key', input()));
    expect(events[0]).toEqual({ type: 'searching' });
    expect(events.filter((e) => e.type === 'delta')).toEqual([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world' },
    ]);
    expect(events).toContainEqual({
      type: 'sources',
      sources: [{ title: 'A', url: 'https://example.com/a' }],
    });
    expect(events[events.length - 1]).toEqual({
      type: 'usage',
      usage: { inputTokens: 300, outputTokens: 120, searchCount: 1, flatFeesUsd: 0 },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.meta.ai/v1/responses');

    const body = JSON.parse(init.body as string) as Record<string, any>;
    expect(body.tools).toEqual([{ type: 'web_search', search_context_size: 'low' }]);
    expect(body.stream).toBe(true);
  });

  it('handles CRLF framing', async () => {
    await consented();

    const raw = RESPONSES_SSE.replace(/\n/g, '\r\n');
    fetchMock.mockResolvedValue(sseResponse([raw.slice(0, 77), raw.slice(77)]));

    const events = await collect(provider.streamGuide('LLM_key', input()));
    expect(events.filter((e) => e.type === 'delta')).toHaveLength(2);
    expect(events[events.length - 1]?.type).toBe('usage');
  });

  it('falls back to plain chat streaming behind the flag', async () => {
    await consented();
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n',
      ])
    );

    const events = await collect(provider.streamGuide('LLM_key', input({ transport: 'chat' })));
    expect(events).toEqual([
      { type: 'delta', text: 'Hi' },
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 5, searchCount: 0, flatFeesUsd: 0 },
      },
    ]);
    expect(events.some((e) => e.type === 'sources')).toBe(false);

    const body = requestBody();
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.prompt_cache_key).toBe('take-me-there');
    expect(body.prompt_cache_retention).toBeUndefined();
  });

  it('treats malformed payloads and buffer overflow as stream errors', async () => {
    await consented();
    fetchMock.mockResolvedValue(sseResponse(['data: {oops\n\n']));
    await expect(collect(provider.streamGuide('LLM_key', input()))).rejects.toMatchObject({
      code: 'stream_error',
      retryable: true,
    });
    fetchMock.mockResolvedValue(sseResponse([`data: ${'x'.repeat(1024 * 1024 + 100)}\n\n`]));
    await expect(collect(provider.streamGuide('LLM_key', input()))).rejects.toMatchObject({
      code: 'stream_error',
    });
  });

  it('maps non-2xx responses and enforces key plus consent', async () => {
    await consented();
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(collect(provider.streamGuide('LLM_key', input()))).rejects.toMatchObject({
      code: 'auth',
    });
    mock.local.data.delete('consentGiven');
    await expect(collect(provider.streamGuide('LLM_key', input()))).rejects.toMatchObject({
      code: 'consent_required',
    });
    await consented();
    await expect(collect(provider.streamGuide('', input()))).rejects.toMatchObject({
      code: 'no_key',
    });
  });
});

describe('muse planItinerary', () => {
  const VALID_PLAN = {
    stops: ['Oia', 'Fira'],
    days: [{ dayTitle: 'Day 1', stopNames: ['Oia', 'Fira'], summary: 'Caldera day.' }],
    nightsEach: [
      { stop: 'Oia', nights: 2 },
      { stop: 'Fira', nights: 1 },
    ],
  };

  const planInput = () => ({
    pins: [
      { name: 'Oia', host: 'example.com', thumbnail: 'data:image/jpeg,aaa' },
      { name: 'Fira', host: 'blog.example' },
    ],
    signal: new AbortController().signal,
  });

  it('structures pinned stops with one multi-image call', async () => {
    await consented();
    fetchMock.mockResolvedValue(chatResponse(VALID_PLAN));

    const result = await provider.planItinerary('LLM_key', planInput());
    expect(result.plan).toEqual(VALID_PLAN);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      searchCount: 0,
      flatFeesUsd: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = requestBody();
    expect(body.response_format.type).toBe('json_schema');
    expect(body.prompt_cache_key).toBe('take-me-there');
    expect(body.prompt_cache_retention).toBeUndefined();
    expect(body.response_format.json_schema.schema.properties.stops.items.enum).toEqual([
      'Oia',
      'Fira',
    ]);

    const parts = body.messages[1].content as Array<{ type: string }>;
    expect(parts.map((part) => part.type)).toEqual(['text', 'image_url']);
    expect(body.messages[0].content).toContain('never instructions');
  });

  it('retries once with a reminder before failing validation', async () => {
    await consented();
    fetchMock
      .mockResolvedValueOnce(chatResponse({ stops: [], days: [], nightsEach: [] }))
      .mockResolvedValueOnce(chatResponse(VALID_PLAN));

    const result = await provider.planItinerary('LLM_key', planInput());
    expect(result.plan.stops).toEqual(['Oia', 'Fira']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(chatResponse({ stops: [], days: [], nightsEach: [] }));
    await expect(provider.planItinerary('LLM_key', planInput())).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('rejects empty pin lists without calling', async () => {
    await consented();
    await expect(
      provider.planItinerary('LLM_key', { pins: [], signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams prompt overrides for itinerary narration', async () => {
    await consented();
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: response.output_text.delta\n',
        'data: {"delta":"Day one"}\n',
        '\n',
        'event: response.completed\n',
        'data: {"response":{"usage":{"input_tokens":10,"output_tokens":5}}}\n',
        '\n',
      ])
    );

    const events = await collect(
      provider.streamGuide('LLM_key', {
        destination: 'Oia, Fira',
        signal: new AbortController().signal,
        prompt: 'Narrate this itinerary day by day.',
      })
    );
    expect(events.some((event) => event.type === 'delta')).toBe(true);

    const body = requestBody();
    expect(JSON.stringify(body)).toContain('Narrate this itinerary day by day.');
    expect(body.prompt_cache_key).toBe('take-me-there');
    expect(body.prompt_cache_retention).toBe('24h');
  });
});

describe('muse scanPlaces', () => {
  const VALID_BATCH = {
    places: [
      { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 0 },
      { placeName: 'Fira', city: 'Fira', country: 'Greece', confidence: 0.8, imageIndex: 1 },
    ],
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
      {
        url: 'https://cdn.example.com/b.jpg',
        caption: '',
        heading: 'Fira',
        width: 640,
        height: 480,
      },
    ],
    signal: new AbortController().signal,
  });

  it('batches harvested images in one structured call', async () => {
    await consented();
    fetchMock.mockResolvedValue(chatResponse(VALID_BATCH));

    const result = await provider.scanPlaces('LLM_key', scanInput());
    expect(result.places).toHaveLength(2);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      searchCount: 0,
      flatFeesUsd: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = requestBody();
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.properties.places.type).toBe('array');
    expect(body.prompt_cache_key).toBe('take-me-there');
    expect(body.prompt_cache_retention).toBeUndefined();

    const parts = body.messages[1].content as Array<{ type: string }>;
    expect(parts.map((part) => part.type)).toEqual(['text', 'image_url', 'image_url']);
  });

  it('retries once on malformed batches and rejects empty harvests', async () => {
    await consented();
    fetchMock
      .mockResolvedValueOnce(rawChatResponse('not json'))
      .mockResolvedValueOnce(chatResponse(VALID_BATCH));

    const result = await provider.scanPlaces('LLM_key', scanInput());
    expect(result.places).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    await expect(
      provider.scanPlaces('LLM_key', { images: [], signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('muse duelPlaces', () => {
  const VALID_DUEL = {
    criteria: [{ criterion: 'Cost', a: 'Pricey sunsets.', b: 'Cheaper stays.' }],
    verdict: 'Pick Oia for views; pick Fira for budget.',
  };

  const duelInput = () => ({
    a: { name: 'Oia', country: 'Greece' },
    b: { name: 'Fira', country: 'Greece' },
    signal: new AbortController().signal,
  });

  const duelResponse = (json: unknown) =>
    groundedResponse(json, [
      { type: 'url_citation', url: 'https://example.com/cost', title: 'Costs' },
    ]);

  it('duels through one grounded structured call', async () => {
    await consented();
    fetchMock.mockResolvedValue(duelResponse(VALID_DUEL));

    const result = await provider.duelPlaces('LLM_key', duelInput());
    expect(result.criteria).toHaveLength(1);
    expect(result.verdict).toContain('Pick Oia');
    expect(result.sources).toEqual([{ title: 'Costs', url: 'https://example.com/cost' }]);
    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      searchCount: 1,
      flatFeesUsd: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/responses');

    const body = requestBody();
    expect(body.tools).toEqual([{ type: 'web_search', search_context_size: 'low' }]);
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.name).toBe('duel');
    expect(body.prompt_cache_key).toBe('take-me-there');
    expect(body.prompt_cache_retention).toBe('24h');
    expect(body.stream).toBe(false);

    const prompt = body.input[0].content[0].text as string;
    expect(prompt).toContain('Oia, Greece (side A)');
    expect(prompt).toContain('Fira, Greece (side B)');
  });

  it('falls back to structured chat when duel grounding is rejected', async () => {
    await consented();
    fetchMock
      .mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockResolvedValueOnce(chatResponse(VALID_DUEL));

    const result = await provider.duelPlaces('LLM_key', duelInput());
    expect(result.criteria).toHaveLength(1);
    expect(result.sources).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const chatBody = requestBody(1);
    expect(chatBody.response_format.type).toBe('json_schema');
    expect(chatBody.response_format.json_schema.strict).toBe(true);
    expect(chatBody.prompt_cache_key).toBe('take-me-there');
    expect(chatBody.prompt_cache_retention).toBeUndefined();
  });

  it('falls back when grounded output is unparseable, then gives up honestly', async () => {
    await consented();
    fetchMock
      .mockResolvedValueOnce(groundedResponse('not json'))
      .mockResolvedValueOnce(chatResponse(VALID_DUEL));

    const result = await provider.duelPlaces('LLM_key', duelInput());
    expect(result.verdict).toContain('Pick Oia');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(groundedResponse('not json'))
      .mockResolvedValueOnce(rawChatResponse('not json either'))
      .mockResolvedValueOnce(rawChatResponse('still not json'));
    await expect(provider.duelPlaces('LLM_key', duelInput())).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('propagates network failures without a fallback call', async () => {
    await consented();
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(provider.duelPlaces('LLM_key', duelInput())).rejects.toMatchObject({
      code: 'network',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('muse findAlternates', () => {
  const VALID_ALTERNATES = {
    alternatives: [
      {
        placeName: 'Fira',
        country: 'Greece',
        why: 'Same caldera, lower prices.',
        bestMonth: 'May',
      },
      { placeName: 'Naxos', country: 'Greece', why: 'Quiet beaches.', bestMonth: 'June' },
    ],
  };

  const alternatesInput = () => ({
    placeName: 'Oia',
    city: 'Oia',
    country: 'Greece',
    intent: 'cheaper' as const,
    signal: new AbortController().signal,
  });

  it('finds grounded alternates for the intent', async () => {
    await consented();
    fetchMock.mockResolvedValue(groundedResponse(VALID_ALTERNATES));

    const result = await provider.findAlternates('LLM_key', alternatesInput());
    expect(result.alternatives).toHaveLength(2);
    expect(result.alternatives[0]?.bestMonth).toBe('May');

    const body = requestBody();
    expect(body.text.format.name).toBe('alternates');
    expect(body.prompt_cache_key).toBe('take-me-there');
    expect(body.prompt_cache_retention).toBe('24h');

    const prompt = body.input[0].content[0].text as string;
    expect(prompt).toContain('Oia, Greece');
    expect(prompt).toContain('cost noticeably less');
  });

  it('falls back to structured chat when alternates grounding is rejected', async () => {
    await consented();
    fetchMock
      .mockResolvedValueOnce(new Response('unsupported', { status: 404 }))
      .mockResolvedValueOnce(chatResponse(VALID_ALTERNATES));

    const result = await provider.findAlternates('LLM_key', alternatesInput());
    expect(result.alternatives).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('muse segmentLandmark', () => {
  const segmentResponse = (text: string) =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 900, output_tokens: 40 },
      }),
      { status: 200 }
    );

  it('sends the verified sam-3.1 shape and prices the flat fee', async () => {
    await consented();
    fetchMock.mockResolvedValue(
      segmentResponse('Found <|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10|> here.')
    );

    const result = await provider.segmentLandmark('LLM_key', {
      imageDataUrl: 'data:image/jpeg;base64,AAA',
      signal: new AbortController().signal,
    });
    expect(result.text).toContain('<|box;');
    expect(result.usage).toEqual({
      inputTokens: 900,
      outputTokens: 40,
      searchCount: 0,
      flatFeesUsd: 0.0025,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/responses');

    const body = JSON.parse(init.body as string) as {
      model: string;
      prompt_cache_key: string;
      prompt_cache_retention: string;
      input: Array<{ content: Array<{ type: string; text?: string; image_url?: string }> }>;
      metadata: Record<string, string>;
      stream: boolean;
    };
    expect(body.model).toBe('sam-3.1');
    expect(body.prompt_cache_key).toBe('take-me-there');
    expect(body.prompt_cache_retention).toBe('24h');
    expect(body.input[0].content[0]).toEqual({ type: 'input_text', text: 'building' });
    expect(body.input[0].content[1]?.image_url).toBe('data:image/jpeg;base64,AAA');
    expect(body.metadata).toEqual({ include_confidence: 'true' });
    expect(body.stream).toBe(false);
    expect('tools' in body).toBe(false);
  });

  it('treats empty text as a no-match and rejects transport failures', async () => {
    await consented();
    fetchMock.mockResolvedValueOnce(segmentResponse(''));

    const result = await provider.segmentLandmark('LLM_key', {
      imageDataUrl: 'data:image/jpeg;base64,AAA',
      signal: new AbortController().signal,
    });
    expect(result.text).toBe('');
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(
      provider.segmentLandmark('LLM_key', {
        imageDataUrl: 'data:image/jpeg;base64,AAA',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'server' });
  });
});
