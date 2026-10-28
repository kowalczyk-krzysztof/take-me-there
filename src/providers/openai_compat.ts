import type { ModelRates } from '../pricing';
import {
  alternatesJsonSchema,
  duelJsonSchema,
  itineraryJsonSchema,
  scanBatchJsonSchema,
} from '../types';
import {
  PROMPT_CACHE_KEY,
  ProviderError,
  assertConsent,
  buildAlternatesMessages,
  buildDuelMessages,
  buildGuidePrompt,
  buildItineraryMessages,
  buildScanMessages,
  emptyUsage,
  extractChatJson,
  fetchChatCompletion,
  invalidResponse,
  parseAlternatesContent,
  parseDuelContent,
  parseItineraryPlan,
  parseScanBatch,
  postChatStream,
  requireKey,
  runIdentify,
  testModelsEndpoint,
  type AlternatesInput,
  type AlternatesResult,
  type ChatMessage,
  type DuelInput,
  type DuelResult,
  type GuideEvent,
  type GuideInput,
  type IdentifyInput,
  type IdentifyRequest,
  type IdentifyResult,
  type ItineraryInput,
  type ItineraryResult,
  type OpenAiCompatSettings,
  type Provider,
  type ProviderCapabilities,
  type ScanInput,
  type ScanResult,
  type SegmentInput,
  type SegmentResult,
  type Usage,
} from './index';

const IDENTIFY_MAX_TOKENS = 2048;

const GUIDE_MAX_TOKENS = 4096;

// Multi-image batches share the muse output budget: 2048 truncates the
// JSON mid-array, and the truncated half bills a strict retry for nothing.
const ITINERARY_MAX_TOKENS = 4096;

export class OpenAiCompatProvider implements Provider {
  readonly id = 'openai_compat';
  readonly capabilities: ProviderCapabilities;

  get modelName(): string {
    return this.config.model;
  }

  private readonly config: OpenAiCompatSettings;

  constructor(config: OpenAiCompatSettings) {
    this.config = config;
    this.capabilities = {
      video: false,
      webGrounding: false,
      segmentation: false,
      structuredOutput: config.structuredOutput,
    };
  }

  getRates(): ModelRates | undefined {
    const { inputRatePerM, outputRatePerM } = this.config;

    if (typeof inputRatePerM === 'number' && typeof outputRatePerM === 'number') {
      return { inputUsdPerMTok: inputRatePerM, outputUsdPerMTok: outputRatePerM };
    }

    return undefined;
  }

  private baseURL(): string {
    const base = this.config.baseURL.replace(/\/+$/, '');

    if (!base || !this.config.model) {
      throw new ProviderError('not_configured', 'openai_compat provider is not configured', false);
    }

    return base;
  }

  async testKey(key: string): Promise<void> {
    await testModelsEndpoint(this.baseURL(), key);
  }

  identifyPlace(key: string, input: IdentifyInput): Promise<IdentifyResult> {
    return runIdentify(key, input, (messages, schema) => this.identifyRequest(messages, schema));
  }

  private identifyRequest(
    messages: ChatMessage[],
    schema: Record<string, unknown>
  ): IdentifyRequest {
    return {
      url: `${this.baseURL()}/chat/completions`,
      body: {
        model: this.config.model,
        prompt_cache_key: PROMPT_CACHE_KEY,
        max_completion_tokens: IDENTIFY_MAX_TOKENS,
        messages,
        response_format:
          this.config.structuredOutput === 'json_schema'
            ? { type: 'json_schema', json_schema: { name: 'place_identification', schema } }
            : { type: 'json_object' },
      },
    };
  }

  async planItinerary(key: string, input: ItineraryInput): Promise<ItineraryResult> {
    requireKey(key);
    await assertConsent();

    const base = this.baseURL();

    const usage = emptyUsage();

    if (input.pins.length === 0) {
      throw invalidResponse(usage, 'no pins to plan');
    }

    const stopNames = input.pins.map((pin) => pin.name);

    for (const strictReminder of [false, true]) {
      const data = await fetchChatCompletion(
        `${base}/chat/completions`,
        key,
        {
          model: this.config.model,
          prompt_cache_key: PROMPT_CACHE_KEY,
          max_completion_tokens: ITINERARY_MAX_TOKENS,
          messages: buildItineraryMessages(input.pins, strictReminder),
          response_format:
            this.config.structuredOutput === 'json_schema'
              ? {
                  type: 'json_schema',
                  json_schema: { name: 'itinerary', schema: itineraryJsonSchema(stopNames) },
                }
              : { type: 'json_object' },
        },
        input.signal,
        usage
      );

      const plan = parseItineraryPlan(data, stopNames);

      if (plan) {
        return { plan, usage: { ...usage } };
      }
    }

    throw invalidResponse(usage, 'model output failed validation');
  }

  async scanPlaces(key: string, input: ScanInput): Promise<ScanResult> {
    requireKey(key);

    await assertConsent();

    const base = this.baseURL();

    const usage = emptyUsage();

    if (input.images.length === 0) {
      throw invalidResponse(usage, 'no images to scan');
    }

    for (const strictReminder of [false, true]) {
      const data = await fetchChatCompletion(
        `${base}/chat/completions`,
        key,
        {
          model: this.config.model,
          prompt_cache_key: PROMPT_CACHE_KEY,
          max_completion_tokens: ITINERARY_MAX_TOKENS,
          messages: buildScanMessages(input.images, strictReminder),
          response_format:
            this.config.structuredOutput === 'json_schema'
              ? {
                  type: 'json_schema',
                  json_schema: { name: 'scan_batch', schema: scanBatchJsonSchema() },
                }
              : { type: 'json_object' },
        },
        input.signal,
        usage
      );

      const places = parseScanBatch(data, input.images.length);

      if (places) {
        return { places, usage: { ...usage } };
      }
    }

    throw invalidResponse(usage, 'model output failed validation');
  }

  // Structured chat only: generic endpoints vary too much to assume a
  // grounded Responses shape, so duels and alternates run ungrounded here
  // with client-side validation doing the real work.
  private async chatStructured<T>(
    key: string,
    signal: AbortSignal,
    usage: Usage,
    name: string,
    schema: Record<string, unknown>,
    messages: (strictReminder: boolean) => ChatMessage[],
    parse: (json: unknown) => T | undefined
  ): Promise<T> {
    const base = this.baseURL();

    for (const strictReminder of [false, true]) {
      const data = await fetchChatCompletion(
        `${base}/chat/completions`,
        key,
        {
          model: this.config.model,
          prompt_cache_key: PROMPT_CACHE_KEY,
          max_completion_tokens: IDENTIFY_MAX_TOKENS,
          messages: messages(strictReminder),
          response_format:
            this.config.structuredOutput === 'json_schema'
              ? {
                  type: 'json_schema',
                  json_schema: { name, schema },
                }
              : { type: 'json_object' },
        },
        signal,
        usage
      );

      const value = parse(extractChatJson(data));

      if (value) {
        return value;
      }
    }

    throw invalidResponse(usage, 'model output failed validation');
  }

  async duelPlaces(key: string, input: DuelInput): Promise<DuelResult> {
    requireKey(key);

    await assertConsent();

    const usage = emptyUsage();

    const verdict = await this.chatStructured(
      key,
      input.signal,
      usage,
      'duel',
      duelJsonSchema(),
      (strictReminder) => buildDuelMessages(input.a, input.b, strictReminder),
      parseDuelContent
    );

    return { ...verdict, sources: [], usage: { ...usage } };
  }

  async findAlternates(key: string, input: AlternatesInput): Promise<AlternatesResult> {
    requireKey(key);

    await assertConsent();

    const usage = emptyUsage();

    const alternatives = await this.chatStructured(
      key,
      input.signal,
      usage,
      'alternates',
      alternatesJsonSchema(),
      (strictReminder) =>
        buildAlternatesMessages(input.placeName, input.country, input.intent, strictReminder),
      parseAlternatesContent
    );

    return { alternatives, sources: [], usage: { ...usage } };
  }

  async segmentLandmark(key: string, _input: SegmentInput): Promise<SegmentResult> {
    requireKey(key);

    await assertConsent();

    throw new ProviderError(
      'not_configured',
      'segmentation is not configured on this provider',
      false
    );
  }

  async *streamGuide(key: string, input: GuideInput): AsyncGenerator<GuideEvent, void, void> {
    requireKey(key);

    await assertConsent();

    const base = this.baseURL();

    const prompt = input.prompt ?? buildGuidePrompt(input.destination, input.language);

    yield* postChatStream(
      `${base}/chat/completions`,
      key,
      {
        model: this.config.model,
        prompt_cache_key: PROMPT_CACHE_KEY,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: GUIDE_MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
      },
      input.signal
    );
  }
}
