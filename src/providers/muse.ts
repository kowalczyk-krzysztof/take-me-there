// Default provider: Meta Muse. Identify runs on chat completions (where
// json_schema is verified); the trip guide streams from the web-grounded
// Responses API with a chat-completions fallback behind the transport flag.
import { EventSourceParserStream, type EventSourceMessage } from 'eventsource-parser/stream';
import { MUSE_SPARK_RATES, type ModelRates } from '../pricing';
import {
  ProviderError,
  SSE_MAX_BUFFER,
  assertConsent,
  buildGuidePrompt,
  decodeStream,
  emptyUsage,
  postChatStream,
  requireKey,
  responseError,
  runIdentify,
  toNetworkError,
  toStreamError,
  type ChatMessage,
  type GuideEvent,
  type GuideInput,
  type GuideSource,
  type IdentifyInput,
  type IdentifyRequest,
  type IdentifyResult,
  type Provider,
  type ProviderCapabilities,
} from './index';

const API_BASE = 'https://api.meta.ai/v1';
const MODEL = 'muse-spark-1.3';
const IDENTIFY_MAX_TOKENS = 2048;
const GUIDE_MAX_TOKENS = 4096;

export class MuseProvider implements Provider {
  readonly id = 'muse';
  readonly capabilities: ProviderCapabilities = {
    video: false,
    webGrounding: true,
    segmentation: false,
    structuredOutput: 'json_schema',
  };

  getRates(modelId: string): ModelRates | undefined {
    return MUSE_SPARK_RATES[modelId];
  }

  async testKey(key: string): Promise<void> {
    requireKey(key);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/models`, {
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
      this.identifyRequest(messages, schema, input.insist ?? false),
    );
  }

  private identifyRequest(
    messages: ChatMessage[],
    schema: Record<string, unknown>,
    insist: boolean,
  ): IdentifyRequest {
    return {
      url: `${API_BASE}/chat/completions`,
      body: {
        model: MODEL,
        reasoning_effort: insist ? 'medium' : 'low',
        max_completion_tokens: IDENTIFY_MAX_TOKENS,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'place_identification', strict: true, schema },
        },
      },
    };
  }

  async *streamGuide(key: string, input: GuideInput): AsyncGenerator<GuideEvent, void, void> {
    requireKey(key);
    await assertConsent();
    const prompt = buildGuidePrompt(input.destination, input.language);
    if (input.transport === 'chat') {
      yield* this.streamGuideChat(key, prompt, input.signal);
    } else {
      yield* this.streamGuideResponses(key, prompt, input.signal);
    }
  }

  private async *streamGuideChat(
    key: string,
    prompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<GuideEvent, void, void> {
    yield* postChatStream(
      `${API_BASE}/chat/completions`,
      key,
      {
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: GUIDE_MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
      },
      signal,
    );
  }

  private async *streamGuideResponses(
    key: string,
    prompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<GuideEvent, void, void> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: MODEL,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: prompt }],
            },
          ],
          tools: [{ type: 'web_search', search_context_size: 'low' }],
          max_output_tokens: GUIDE_MAX_TOKENS,
          stream: true,
        }),
        signal,
      });
    } catch (err) {
      throw toNetworkError(err, signal);
    }
    if (!res.ok) {
      throw responseError(res);
    }
    if (!res.body) {
      throw new ProviderError('stream_error', 'empty response body', true);
    }
    const usage = emptyUsage();
    const sources: GuideSource[] = [];
    const seenUrls = new Set<string>();
    let announcedSearching = false;
    const parser = decodeStream(res.body).pipeThrough(
      new EventSourceParserStream({ maxBufferSize: SSE_MAX_BUFFER, onError: 'terminate' }),
    );
    const reader = parser.getReader();
    try {
      for (;;) {
        if (signal.aborted) {
          throw new ProviderError('aborted', 'request aborted', false);
        }
        let result: ReadableStreamReadResult<EventSourceMessage>;
        try {
          result = await reader.read();
        } catch (err) {
          throw toStreamError(err, signal);
        }
        if (result.done) {
          break;
        }
        const message = result.value;
        const name = message.event ?? '';
        if (name === 'keepalive') {
          continue;
        }
        if (name === '') {
          // The Responses contract is fully named events: an unnamed block
          // means we are not talking to the expected endpoint.
          const data = message.data.trim();
          if (data === '') {
            continue;
          }
          if (data === '[DONE]') {
            break;
          }
          throw new ProviderError('stream_error', 'unnamed stream payload', true);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(message.data);
        } catch {
          throw new ProviderError('stream_error', `malformed ${name} payload`, true);
        }
        if (name === 'response.output_text.delta') {
          const delta = (payload as { delta?: unknown })?.delta;
          if (typeof delta === 'string' && delta) {
            yield { type: 'delta', text: delta };
          }
        } else if (name === 'response.output_text.annotation.added') {
          const annotation = (payload as { annotation?: { type?: unknown; url?: unknown; title?: unknown } })
            ?.annotation;
          if (
            annotation?.type === 'url_citation' &&
            typeof annotation.url === 'string' &&
            annotation.url &&
            !seenUrls.has(annotation.url)
          ) {
            seenUrls.add(annotation.url);
            sources.push({
              title: typeof annotation.title === 'string' ? annotation.title : '',
              url: annotation.url,
            });
          }
        } else if (
          name === 'response.web_search_call.in_progress' ||
          name === 'response.web_search_call.searching'
        ) {
          if (!announcedSearching) {
            announcedSearching = true;
            yield { type: 'searching' };
          }
        } else if (name === 'response.web_search_call.completed') {
          usage.searchCount += 1;
          if (!announcedSearching) {
            announcedSearching = true;
            yield { type: 'searching' };
          }
        } else if (name === 'response.completed') {
          const tokens = (payload as { response?: { usage?: unknown }; usage?: unknown })
            ?.response;
          const usagePayload =
            (tokens as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | undefined)
              ?.usage ??
            (payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown } })?.usage;
          if (usagePayload && typeof usagePayload.input_tokens === 'number') {
            usage.inputTokens += usagePayload.input_tokens;
            usage.outputTokens +=
              typeof usagePayload.output_tokens === 'number' ? usagePayload.output_tokens : 0;
          }
          break;
        }
        // Every other event is ignored by design.
      }
    } finally {
      reader.releaseLock();
    }
    if (sources.length > 0) {
      yield { type: 'sources', sources };
    }
    yield { type: 'usage', usage };
  }
}
