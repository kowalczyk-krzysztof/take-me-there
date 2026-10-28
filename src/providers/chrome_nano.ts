import type { ModelRates } from '../pricing';
import {
  alternatesJsonSchema,
  duelJsonSchema,
  itineraryJsonSchema,
  placeJsonSchema,
  scanBatchJsonSchema,
} from '../types';
import { dataUrlToBytes } from '../sam';
import { downscaleToJpegDataUrl, fetchImageBytes } from '../image_fetch';
import {
  ProviderError,
  buildAlternatesMessages,
  buildDuelMessages,
  buildGuidePrompt,
  buildIdentifyMessages,
  buildItineraryMessages,
  buildScanMessages,
  chatToText,
  emptyUsage,
  invalidResponse,
  parseAlternatesContent,
  parseDuelContent,
  parseItineraryContent,
  parseScanContent,
  sanitizePromptHint,
  tryParsePlaceJson,
  type AlternatesInput,
  type AlternatesResult,
  type ChatMessage,
  type DuelInput,
  type DuelResult,
  type GuideEvent,
  type GuideInput,
  type IdentifyInput,
  type IdentifyResult,
  type ItineraryInput,
  type ItineraryResult,
  type Provider,
  type ProviderCapabilities,
  type ScanInput,
  type ScanResult,
  type SegmentInput,
  type SegmentResult,
} from './index';

export type NanoAvailability = 'readily' | 'downloadable' | 'downloading' | 'unavailable';

interface NanoSession {
  prompt: (input: unknown, options?: Record<string, unknown>) => Promise<string>;
  promptStreaming: (input: string) => AsyncIterable<string>;
  clone: () => Promise<NanoSession>;
  destroy: () => void;
}

interface NanoLanguageModel {
  availability: (options: unknown) => Promise<string>;
  create: (options?: Record<string, unknown>) => Promise<NanoSession>;
}

const languageModel = (): NanoLanguageModel | null => {
  try {
    const candidate = (globalThis as unknown as { LanguageModel?: NanoLanguageModel })
      .LanguageModel;
    if (!candidate || typeof candidate.availability !== 'function') {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
};

// The extension ships English only, so every session asks for English
// output. Chrome requires the code for quality and safety attestation.
const OUTPUT_LANGUAGE = 'en';

// Availability answers are option-specific: always probe with the exact
// options used (text + image inputs, English output). Anything unexpected
// means unavailable.
export const nanoAvailability = async (): Promise<NanoAvailability> => {
  try {
    const model = languageModel();
    if (!model) {
      return 'unavailable';
    }
    const state = await model.availability({
      expectedInputs: [{ type: 'text' }, { type: 'image' }],
      outputLanguage: OUTPUT_LANGUAGE,
    });
    return state === 'readily' || state === 'downloadable' || state === 'downloading'
      ? state
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
};

let baseSession: NanoSession | null = null;

export const resetNanoSession = (): void => {
  const session = baseSession;
  baseSession = null;
  try {
    session?.destroy();
  } catch {
    // A dead session has nothing to release.
  }
};

// One-shot model download with progress. Resolves with a cached base
// session; a missing progress monitor degrades to indeterminate UI.
export const downloadNanoModel = async (onProgress: (frac: number) => void): Promise<void> => {
  const model = languageModel();
  if (!model || typeof model.create !== 'function') {
    throw new ProviderError('not_configured', 'on-device model is unavailable', false);
  }
  resetNanoSession();
  let session: NanoSession;
  try {
    session = await model.create({
      outputLanguage: OUTPUT_LANGUAGE,
      monitor: (monitor: {
        addEventListener: (name: string, fn: (event: { loaded?: unknown }) => void) => void;
      }) => {
        try {
          monitor.addEventListener('downloadprogress', (event) => {
            const frac = Number(event?.loaded);
            if (Number.isFinite(frac)) {
              onProgress(Math.min(1, Math.max(0, frac)));
            }
          });
        } catch {
          // No monitor: the progress bar stays indeterminate.
        }
      },
    });
  } catch (err) {
    throw toNanoError(err, undefined);
  }
  baseSession = session;
  if ((await nanoAvailability()) !== 'readily') {
    resetNanoSession();
    throw new ProviderError('not_configured', 'on-device model is not ready', false);
  }
};

const toNanoError = (err: unknown, signal: AbortSignal | undefined): ProviderError => {
  if (signal?.aborted) {
    return new ProviderError('aborted', 'request aborted', false);
  }
  if (err instanceof ProviderError) {
    return err;
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new ProviderError('aborted', 'request aborted', false);
  }
  return invalidResponse(
    emptyUsage(),
    err instanceof Error ? err.message : 'on-device inference failed',
  );
};

// Availability is re-checked before every use: Chrome auto-deletes the
// model under disk pressure, so a cached session is never trusted blindly.
const acquireNanoSession = async (
  signal: AbortSignal | undefined,
): Promise<{ session: NanoSession; release: () => void }> => {
  if ((await nanoAvailability()) !== 'readily') {
    resetNanoSession();
    throw new ProviderError('not_configured', 'on-device model is not ready', false);
  }
  const model = languageModel();
  if (!model) {
    throw new ProviderError('not_configured', 'on-device model is unavailable', false);
  }
  if (!baseSession) {
    try {
      baseSession = await model.create({ outputLanguage: OUTPUT_LANGUAGE });
    } catch (err) {
      throw toNanoError(err, signal);
    }
  }
  try {
    const session = await baseSession.clone();
    return {
      session,
      release: () => {
        try {
          session.destroy();
        } catch {
          // Clone teardown is best effort.
        }
      },
    };
  } catch {
    // Stale base session: rebuild once, then run against the fresh clone.
    resetNanoSession();
    try {
      baseSession = await model.create({ outputLanguage: OUTPUT_LANGUAGE });
      const session = await baseSession.clone();
      return {
        session,
        release: () => {
          try {
            session.destroy();
          } catch {
            // Clone teardown is best effort.
          }
        },
      };
    } catch (err) {
      throw toNanoError(err, signal);
    }
  }
};

const withNanoSession = async <T>(
  signal: AbortSignal | undefined,
  fn: (session: NanoSession) => Promise<T>,
): Promise<T> => {
  const { session, release } = await acquireNanoSession(signal);
  try {
    return await fn(session);
  } catch (err) {
    throw toNanoError(err, signal);
  } finally {
    release();
  }
};

// Image bytes for the on-device model: held data first, then a plain fetch
// (CORS-gated by the server), else signals-only. Normalized to a bounded
// JPEG so a huge original cannot blow the context.
const nanoImageBlob = async (imageUrl: string | null): Promise<Blob | null> => {
  try {
    if (!imageUrl) {
      return null;
    }
    if (imageUrl.startsWith('data:image/')) {
      const bytes = dataUrlToBytes(imageUrl);
      if (!bytes) {
        return null;
      }
      const dataUrl = await downscaleToJpegDataUrl(bytes);
      const norm = dataUrlToBytes(dataUrl);
      return norm ? new Blob([norm as BlobPart], { type: 'image/jpeg' }) : null;
    }
    if (!imageUrl.startsWith('https://')) {
      return null;
    }
    const bytes = await fetchImageBytes(imageUrl, new AbortController().signal);
    const dataUrl = await downscaleToJpegDataUrl(bytes);
    const norm = dataUrlToBytes(dataUrl);
    return norm ? new Blob([norm as BlobPart], { type: 'image/jpeg' }) : null;
  } catch {
    return null;
  }
};

const promptJson = async <T>(
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  parse: (json: unknown) => T | undefined,
  signal: AbortSignal,
  image?: Blob | null,
): Promise<T> => {
  const text = chatToText(messages);
  const input = image
    ? [
        {
          role: 'user',
          content: [
            { type: 'text', value: text },
            { type: 'image', value: image },
          ],
        },
      ]
    : text;
  const usage = emptyUsage();
  const answer = await withNanoSession(signal, async (session) => {
    try {
      return await session.prompt(input, { responseConstraint: schema, signal });
    } catch (err) {
      // The image part is speculative API surface: a multimodal rejection
      // retries text-only once before failing the call.
      if (image && !signal.aborted) {
        return await session.prompt(text, { responseConstraint: schema, signal });
      }
      throw err;
    }
  });
  let json: unknown;
  try {
    json = JSON.parse(answer) as unknown;
  } catch {
    throw invalidResponse(usage, 'model output failed validation');
  }
  const value = parse(json);
  if (value === undefined) {
    throw invalidResponse(usage, 'model output failed validation');
  }
  return value;
};

export class ChromeNanoProvider implements Provider {
  readonly id = 'chrome_nano';
  readonly capabilities: ProviderCapabilities = {
    video: false,
    webGrounding: false,
    segmentation: false,
    structuredOutput: 'json_schema',
    onDevice: true,
  };

  getRates(): ModelRates | undefined {
    return { inputUsdPerMTok: 0, outputUsdPerMTok: 0 };
  }

  async testKey(_key: string): Promise<void> {
    if ((await nanoAvailability()) !== 'readily') {
      throw new ProviderError('not_configured', 'on-device model is not ready', false);
    }
  }

  async identifyPlace(_key: string, input: IdentifyInput): Promise<IdentifyResult> {
    const usage = emptyUsage();
    const messages = buildIdentifyMessages({
      signalsText: input.signalsText,
      imageUrl: null,
      rejectedPlace: input.rejectedPlace ? sanitizePromptHint(input.rejectedPlace) : undefined,
      strictReminder: false,
      videoUrl: null,
    });
    // Page signals first, image as supporting evidence: Nano carries no
    // landmark-recognition claim, so the prompt refuses cheaply.
    const blob = await nanoImageBlob(input.imageUrl);
    const place = await promptJson(
      messages,
      placeJsonSchema(),
      tryParsePlaceJson,
      input.signal,
      blob,
    );
    return { place, usage: { ...usage }, textFallback: !blob };
  }

  async *streamGuide(_key: string, input: GuideInput): AsyncGenerator<GuideEvent, void, void> {
    const prompt = input.prompt ?? buildGuidePrompt(input.destination, input.language);
    const usage = emptyUsage();
    const { session, release } = await acquireNanoSession(input.signal);
    try {
      for await (const chunk of session.promptStreaming(prompt)) {
        if (input.signal.aborted) {
          throw new ProviderError('aborted', 'request aborted', false);
        }
        if (chunk) {
          yield { type: 'delta', text: chunk };
        }
      }
    } catch (err) {
      throw toNanoError(err, input.signal);
    } finally {
      release();
    }
    yield { type: 'usage', usage: { ...usage } };
  }

  async planItinerary(_key: string, input: ItineraryInput): Promise<ItineraryResult> {
    const usage = emptyUsage();
    const stopNames = input.pins.map((pin) => pin.name);
    if (stopNames.length === 0) {
      throw invalidResponse(usage, 'no pins to plan');
    }
    const plan = await promptJson(
      buildItineraryMessages(input.pins, false),
      itineraryJsonSchema(stopNames),
      (json) => parseItineraryContent(json, stopNames),
      input.signal,
    );
    return { plan, usage: { ...usage } };
  }

  async scanPlaces(_key: string, input: ScanInput): Promise<ScanResult> {
    const usage = emptyUsage();
    if (input.images.length === 0) {
      throw invalidResponse(usage, 'no images to scan');
    }
    const places = await promptJson(
      buildScanMessages(input.images, false),
      scanBatchJsonSchema(),
      parseScanContent,
      input.signal,
    );
    if (!places) {
      throw invalidResponse(usage, 'model output failed validation');
    }
    return { places, usage: { ...usage } };
  }

  async duelPlaces(_key: string, input: DuelInput): Promise<DuelResult> {
    const usage = emptyUsage();
    const verdict = await promptJson(
      buildDuelMessages(input.a, input.b, false),
      duelJsonSchema(),
      parseDuelContent,
      input.signal,
    );
    return { ...verdict, sources: [], usage: { ...usage } };
  }

  async findAlternates(_key: string, input: AlternatesInput): Promise<AlternatesResult> {
    const usage = emptyUsage();
    const alternatives = await promptJson(
      buildAlternatesMessages(input.placeName, input.country, input.intent, false),
      alternatesJsonSchema(),
      parseAlternatesContent,
      input.signal,
    );
    return { alternatives, sources: [], usage: { ...usage } };
  }

  async segmentLandmark(_key: string, _input: SegmentInput): Promise<SegmentResult> {
    throw new ProviderError('not_configured', 'segmentation is not available on-device', false);
  }
}
