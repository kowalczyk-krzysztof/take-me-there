// Generic OpenAI-compatible provider: any endpoint with a base URL, model,
// and key. The extras stay flagged off; structured output follows the
// configured mode (json_schema when the endpoint supports it, otherwise
// json_object with client-side validation doing the real work).
import type { ModelRates } from '../pricing';
import {
  ProviderError,
  assertConsent,
  buildGuidePrompt,
  postChatStream,
  requireKey,
  responseError,
  runIdentify,
  toNetworkError,
  type ChatMessage,
  type GuideEvent,
  type GuideInput,
  type IdentifyInput,
  type IdentifyRequest,
  type IdentifyResult,
  type OpenAiCompatSettings,
  type Provider,
  type ProviderCapabilities,
} from './index';

const IDENTIFY_MAX_TOKENS = 2048;
const GUIDE_MAX_TOKENS = 4096;

export class OpenAiCompatProvider implements Provider {
  readonly id = 'openai_compat';
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly config: OpenAiCompatSettings) {
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
    requireKey(key);
    const base = this.baseURL();
    let res: Response;
    try {
      res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
      });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) {
      throw responseError(res);
    }
  }

  identifyPlace(key: string, input: IdentifyInput): Promise<IdentifyResult> {
    return runIdentify(key, input, (messages, schema) =>
      this.identifyRequest(messages, schema),
    );
  }

  private identifyRequest(
    messages: ChatMessage[],
    schema: Record<string, unknown>,
  ): IdentifyRequest {
    return {
      url: `${this.baseURL()}/chat/completions`,
      body: {
        model: this.config.model,
        max_completion_tokens: IDENTIFY_MAX_TOKENS,
        messages,
        response_format:
          this.config.structuredOutput === 'json_schema'
            ? { type: 'json_schema', json_schema: { name: 'place_identification', schema } }
            : { type: 'json_object' },
      },
    };
  }

  async *streamGuide(key: string, input: GuideInput): AsyncGenerator<GuideEvent, void, void> {
    requireKey(key);
    await assertConsent();
    const base = this.baseURL();
    const prompt = buildGuidePrompt(input.destination, input.language);
    yield* postChatStream(
      `${base}/chat/completions`,
      key,
      {
        model: this.config.model,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: GUIDE_MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
      },
      input.signal,
    );
  }
}
