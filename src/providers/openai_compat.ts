import type { ModelRates } from '../pricing';
import { parseEndpointOrigin } from '../settings_store';
import { alternatesJsonSchema, scanBatchJsonSchema } from '../types';
import {
  PROMPT_CACHE_KEY,
  ProviderError,
  assertConsent,
  buildAlternatesMessages,
  buildScanMessages,
  emptyUsage,
  extractChatJson,
  fetchChatCompletion,
  filterScanImages,
  invalidResponse,
  parseAlternatesContent,
  parseScanBatch,
  remapScanPlaces,
  requireKey,
  runIdentify,
  testModelsEndpoint,
  type AlternatesInput,
  type AlternatesResult,
  type ChatMessage,
  type IdentifyInput,
  type IdentifyRequest,
  type IdentifyResult,
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

// Multi-image batches share the muse output budget: 2048 truncates the
// JSON mid-array, and the truncated half bills a strict retry for nothing.
const STRUCTURED_MAX_TOKENS = 4096;

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
      structuredOutput: 'json_schema',
    };
  }

  // Custom servers never report pricing: runs show token counts with no
  // dollar figure, and the monthly total stays untouched.
  getRates(): ModelRates | undefined {
    return undefined;
  }

  private baseURL(): string {
    const base = this.config.baseURL.replace(/\/+$/, '');

    if (!base || !this.config.model) {
      throw new ProviderError('not_configured', 'openai_compat provider is not configured', false);
    }

    try {
      parseEndpointOrigin(base);
    } catch {
      throw new ProviderError(
        'not_configured',
        'openai_compat endpoint URL is not supported',
        false
      );
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
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'place_identification', schema },
        },
      },
    };
  }

  async scanPlaces(key: string, input: ScanInput): Promise<ScanResult> {
    requireKey(key);

    await assertConsent();

    const base = this.baseURL();

    const usage = emptyUsage();

    if (input.images.length === 0) {
      throw invalidResponse(usage, 'no images to scan');
    }

    const { kept, originalIndex } = filterScanImages(input.images);

    if (kept.length === 0) {
      return { places: [], usage: { ...usage } };
    }

    for (const strictReminder of [false, true]) {
      const data = await fetchChatCompletion(
        `${base}/chat/completions`,
        key,
        {
          model: this.config.model,
          prompt_cache_key: PROMPT_CACHE_KEY,
          max_completion_tokens: STRUCTURED_MAX_TOKENS,
          messages: buildScanMessages(kept, strictReminder),
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'scan_batch', schema: scanBatchJsonSchema() },
          },
        },
        input.signal,
        usage
      );

      const places = parseScanBatch(data, kept.length);

      if (places) {
        return { places: remapScanPlaces(places, originalIndex), usage: { ...usage } };
      }
    }

    throw invalidResponse(usage, 'model output failed validation');
  }

  // Structured chat only: generic endpoints vary too much to assume a
  // grounded Responses shape, so alternates run ungrounded here
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
          response_format: {
            type: 'json_schema',
            json_schema: { name, schema },
          },
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

    return { alternatives, usage: { ...usage } };
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
}
