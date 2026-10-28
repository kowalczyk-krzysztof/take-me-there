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

export const SCANNED_IMAGE_SCHEMA = z.strictObject({
  url: z.string(),
  caption: z.string(),
  heading: z.string(),
  width: z.number(),
  height: z.number(),
});
export type ScannedImage = z.infer<typeof SCANNED_IMAGE_SCHEMA>;

// The worker-to-panel handoff record. Signals ride along only once the
// scrape settles (the 'ready' terminal write); video clicks add the media
// marker plus either the captured frame or its failure reason; page scans
// add the harvested image list.
export const TRIP_REQUEST_SCHEMA = z.strictObject({
  requestId: z.string(),
  status: z.enum(['collecting', 'ready']),
  srcUrl: z.string(),
  dataPending: z.boolean(),
  pageUrl: z.nullable(z.string()),
  tabId: z.number(),
  signals: z.optional(PAGE_SIGNALS_SCHEMA),
  mediaType: z.optional(z.enum(['image', 'video'])),
  frame: z.optional(
    z.strictObject({
      dataUrl: z.string(),
      time: z.number(),
    }),
  ),
  frameError: z.optional(FRAME_FAILURE_SCHEMA),
  scanImages: z.optional(z.array(SCANNED_IMAGE_SCHEMA)),
});
export type TripRequest = z.infer<typeof TRIP_REQUEST_SCHEMA>;

// Itinerary structure: stop names are constrained to an enum of the pinned
// place names, so the model can only sequence user-selected pins, never
// invent stops. Every enum use site builds a FRESH z.enum: sharing one
// instance makes toJSONSchema emit $defs/$ref, which the strict subset
// forbids. Night counts stay bounds-free in the schema (subset risk) and are
// clamped client-side instead.
export interface ItineraryDay {
  dayTitle: string;
  stopNames: string[];
  summary: string;
}

export interface ItineraryNight {
  stop: string;
  nights: number;
}

export interface ItineraryPlan {
  stops: string[];
  days: ItineraryDay[];
  nightsEach: ItineraryNight[];
}

export const itinerarySchema = (stopNames: string[]) => {
  if (stopNames.length === 0) {
    throw new Error('itinerarySchema needs at least one stop name');
  }
  const names = stopNames as [string, ...string[]];
  return z.strictObject({
    stops: z.array(z.enum(names)),
    days: z.array(
      z.strictObject({
        dayTitle: z.string().check(z.maxLength(80)),
        stopNames: z.array(z.enum(names)),
        summary: z.string().check(z.maxLength(500)),
      }),
    ),
    nightsEach: z.array(
      z.strictObject({
        stop: z.enum(names),
        nights: z.number(),
      }),
    ),
  });
};

export const itineraryJsonSchema = (stopNames: string[]): Record<string, unknown> => {
  const emitted = z.toJSONSchema(itinerarySchema(stopNames)) as unknown as Record<string, unknown>;
  const { $schema: _dropped, ...schema } = emitted;
  return schema;
};

// Lenient client-side shape for itinerary answers: the strict server schema
// already constrains conforming output, and this pass drops non-enum stops
// (instead of rejecting the whole plan) for anything that slips through.
export const looseItinerarySchema = () =>
  z.strictObject({
    stops: z.array(z.string()),
    days: z.array(
      z.strictObject({
        dayTitle: z.string(),
        stopNames: z.array(z.string()),
        summary: z.string(),
      }),
    ),
    nightsEach: z.array(
      z.strictObject({
        stop: z.string(),
        nights: z.unknown(),
      }),
    ),
  });

// Page-scan batch: per-image place guesses with the harvest index bounded
// to the collector's dozen. The array rides inside a {places} wrapper:
// top-level arrays are outside the conservative strict subset.
export interface ScannedPlace {
  placeName: string;
  city: string;
  country: string;
  confidence: number;
  imageIndex: number;
}

export const scanPlaceSchema = () =>
  z.strictObject({
    placeName: z.string().check(z.maxLength(100)),
    city: z.string().check(z.maxLength(100)),
    country: z.string().check(z.maxLength(100)),
    confidence: z.number(),
    imageIndex: z.int().check(z.minimum(0), z.maximum(11)),
  });

export const DUEL_MAX_CRITERIA = 8;
export const ALTERNATES_MAX_COUNT = 3;

export interface DuelCriterion {
  criterion: string;
  a: string;
  b: string;
}

export interface DuelVerdict {
  criteria: DuelCriterion[];
  verdict: string;
}

export const duelSchema = () =>
  z.strictObject({
    criteria: z.array(
      z.strictObject({
        criterion: z.string().check(z.maxLength(40)),
        a: z.string().check(z.maxLength(140)),
        b: z.string().check(z.maxLength(140)),
      }),
    ),
    verdict: z.string().check(z.maxLength(300)),
  });

export const duelJsonSchema = (): Record<string, unknown> => {
  const emitted = z.toJSONSchema(duelSchema()) as unknown as Record<string, unknown>;
  const { $schema: _dropped, ...schema } = emitted;
  return schema;
};

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
      }),
    ),
  });

export const alternatesJsonSchema = (): Record<string, unknown> => {
  const emitted = z.toJSONSchema(alternatesSchema()) as unknown as Record<string, unknown>;
  const { $schema: _dropped, ...schema } = emitted;
  return schema;
};

export const scanBatchJsonSchema = (): Record<string, unknown> => {
  const emitted = z.toJSONSchema(
    z.strictObject({ places: z.array(scanPlaceSchema()) }),
  ) as unknown as Record<string, unknown>;
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
