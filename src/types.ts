// zod schemas as the single source of truth: they emit the Muse
// response_format payload, validate parsed model output, and produce the
// shared TypeScript types via z.infer. Import from 'zod/mini' only: a plain
// 'zod' import silently multiplies the bundle (enforced by a pre-zip grep).
import * as z from 'zod/mini';

// Identify output: every string carries maxLength, the object is strict, and
// every property is required. This is exactly Muse's strict subset.
export const PLACE_SCHEMA = z.strictObject({
  identified: z.boolean(),
  placeName: z.string().check(z.maxLength(100)),
  city: z.string().check(z.maxLength(100)),
  country: z.string().check(z.maxLength(100)),
  confidence: z.number(),
  oneLiner: z.string().check(z.maxLength(300)),
});

export type PlaceResult = z.infer<typeof PLACE_SCHEMA>;

// Cache identity input: bump when identify prompts change meaning
// so stale entries from older prompts stop matching.
export const PROMPT_VERSION = 1;

// Bounded cache entry: validates stored results on read and outbound
// writes through the storage commands.
export const CACHE_ENTRY_SCHEMA = z.strictObject({
  place: PLACE_SCHEMA,
  usage: z.strictObject({
    inputTokens: z.number(),
    outputTokens: z.number(),
    searchCount: z.number(),
    flatFeesUsd: z.number(),
    cachedInputTokens: z.optional(z.number()),
  }),
});

// Payload for the Muse response_format json_schema. toJSONSchema always adds
// a top-level $schema key, which the strict subset forbids, so drop it here.
// $ref/$defs must never appear: the unit test fails the build if a later
// schema edit introduces them.
export const placeJsonSchema = (): Record<string, unknown> => {
  const emitted = z.toJSONSchema(PLACE_SCHEMA) as unknown as Record<string, unknown>;

  const { $schema: _dropped, ...schema } = emitted;

  return schema;
};

const JSON_LD_SCHEMA = z.strictObject({
  types: z.array(z.string()),
  name: z.string(),
  locality: z.string(),
  country: z.string(),
  lat: z.nullable(z.number()),
  lon: z.nullable(z.number()),
});

// The page scraper's output shape, mirrored from the self-contained injected
// module (which cannot import this file). The panel validates the handoff
// against this before trusting it.
export const PAGE_SIGNALS_SCHEMA = z.strictObject({
  imgFound: z.boolean(),
  alt: z.string(),
  imgTitle: z.string(),
  figcaption: z.string(),
  nearestHeading: z.string(),
  nearestParagraph: z.string(),
  ogTitle: z.string(),
  ogDescription: z.string(),
  ogSiteName: z.string(),
  docTitle: z.string(),
  metaDescription: z.string(),
  canonical: z.string(),
  pageHost: z.string(),
  urlSlug: z.string(),
  imgFileSlug: z.string(),
  jsonLd: z.array(JSON_LD_SCHEMA),
});

export type PageSignals = z.infer<typeof PAGE_SIGNALS_SCHEMA>;

// Frame-capture failure reasons, mirrored from the self-contained injected
// module (which cannot import this file).
export const FRAME_FAILURE_SCHEMA = z.enum([
  'no-match',
  'no-dimensions',
  'tainted',
  'drm',
  'too-large',
]);

export type FrameFailureReason = z.infer<typeof FRAME_FAILURE_SCHEMA>;

// The worker-to-panel handoff record. Signals ride along only once the
// scrape settles (the 'ready' terminal write); video clicks add the media
// marker plus either the captured frame or its failure reason.
export const TRIP_REQUEST_SCHEMA = z.strictObject({
  requestId: z.string(),
  seq: z.number(),
  status: z.enum(['collecting', 'ready', 'error']),
  srcUrl: z.string(),
  dataPending: z.boolean(),
  pageUrl: z.nullable(z.string()),
  tabId: z.number(),
  frameId: z.optional(z.number()),
  windowId: z.number(),
  at: z.number(),
  reason: z.optional(z.string()),
  signals: z.optional(PAGE_SIGNALS_SCHEMA),
  mediaType: z.optional(z.enum(['video'])),
  frame: z.optional(
    z.strictObject({
      dataUrl: z.string(),
      time: z.number(),
    })
  ),
  frameError: z.optional(FRAME_FAILURE_SCHEMA),
});

export type TripRequest = z.infer<typeof TRIP_REQUEST_SCHEMA>;

export const ALTERNATES_MAX_COUNT = 3;

export interface PlaceAlternate {
  placeName: string;
  country: string;
  why: string;
  bestMonth: string;
}

export const alternatesSchema = () =>
  z.strictObject({
    alternatives: z.array(
      z.strictObject({
        placeName: z.string().check(z.maxLength(100)),
        country: z.string().check(z.maxLength(100)),
        why: z.string().check(z.maxLength(140)),
        bestMonth: z.string().check(z.maxLength(20)),
      })
    ),
  });

export const alternatesJsonSchema = (): Record<string, unknown> => {
  const emitted = z.toJSONSchema(alternatesSchema()) as unknown as Record<string, unknown>;

  const { $schema: _dropped, ...schema } = emitted;

  return schema;
};

export const PROVIDER_CAPABILITIES_SCHEMA = z.strictObject({
  video: z.boolean(),
  webGrounding: z.boolean(),
  segmentation: z.boolean(),
  structuredOutput: z.enum(['json_schema', 'json_object', 'none']),
});

export type ProviderCapabilities = z.infer<typeof PROVIDER_CAPABILITIES_SCHEMA>;
