import { describe, expect, it } from 'vitest';
import {
  PAGE_SIGNALS_SCHEMA,
  PLACE_SCHEMA,
  PROVIDER_CAPABILITIES_SCHEMA,
  TRIP_REQUEST_SCHEMA,
  placeJsonSchema,
} from './types';

function forbiddenKeys(value: unknown, path = '$'): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...forbiddenKeys(item, `${path}[${index}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === '$ref' || key === '$defs' || key === '$schema') {
        hits.push(`${path}.${key}`);
      }
      hits.push(...forbiddenKeys(entry, `${path}.${key}`));
    }
  }
  return hits;
}

function assertStrictSubset(schema: Record<string, unknown>, path = '$'): void {
  expect(schema.type, `${path} is an object`).toBe('object');
  expect(schema.additionalProperties, `${path} forbids extra keys`).toBe(false);
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const required = schema.required as string[];
  expect([...required].sort(), `${path} requires every property`).toEqual(
    Object.keys(props).sort(),
  );
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === 'string') {
      expect(typeof prop.maxLength, `${path}.${name} has maxLength`).toBe('number');
    }
    if (prop.type === 'object') {
      assertStrictSubset(prop, `${path}.${name}`);
    }
  }
}

const VALID_PLACE = {
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.9,
  oneLiner: 'Blue domes over the caldera.',
};

function validSignals() {
  return {
    imgFound: true,
    alt: 'Blue domes',
    imgTitle: '',
    figcaption: '',
    nearestHeading: '',
    nearestParagraph: '',
    ogTitle: '',
    ogDescription: '',
    ogSiteName: '',
    docTitle: 'Guide',
    metaDescription: '',
    canonical: 'https://example.com/guide',
    pageHost: 'example.com',
    urlSlug: 'guide',
    imgFileSlug: 'oia',
    jsonLd: [],
  };
}

describe('place schema pipeline', () => {
  it('emits exactly the strict subset Muse requires', () => {
    const schema = placeJsonSchema();
    assertStrictSubset(schema);
    expect(forbiddenKeys(schema)).toEqual([]);
  });

  it('accepts a valid place', () => {
    expect(PLACE_SCHEMA.safeParse(VALID_PLACE).success).toBe(true);
  });

  it('rejects oversized, type-confused, incomplete, and loose output', () => {
    expect(
      PLACE_SCHEMA.safeParse({ ...VALID_PLACE, placeName: 'x'.repeat(101) }).success,
    ).toBe(false);
    expect(PLACE_SCHEMA.safeParse({ ...VALID_PLACE, identified: 'yes' }).success).toBe(false);
    expect(PLACE_SCHEMA.safeParse({ ...VALID_PLACE, confidence: 'high' }).success).toBe(false);
    const { country: _dropped, ...missingCountry } = VALID_PLACE;
    expect(PLACE_SCHEMA.safeParse(missingCountry).success).toBe(false);
    expect(PLACE_SCHEMA.safeParse({ ...VALID_PLACE, extra: 1 }).success).toBe(false);
  });
});

describe('handoff schemas', () => {
  it('validates the worker-to-panel handoff shape', () => {
    const collecting = {
      requestId: '1-2',
      status: 'collecting',
      srcUrl: 'https://cdn.example.com/oia.jpg',
      dataPending: false,
      pageUrl: 'https://example.com/guide',
      tabId: 7,
    };
    expect(TRIP_REQUEST_SCHEMA.safeParse(collecting).success).toBe(true);
    expect(
      TRIP_REQUEST_SCHEMA.safeParse({ ...collecting, status: 'ready', signals: validSignals() })
        .success,
    ).toBe(true);
    expect(
      TRIP_REQUEST_SCHEMA.safeParse({ ...collecting, status: 'bogus' }).success,
    ).toBe(false);
    expect(TRIP_REQUEST_SCHEMA.safeParse({ ...collecting, signals: {} }).success).toBe(false);
  });

  it('validates page signals and capabilities', () => {
    expect(PAGE_SIGNALS_SCHEMA.safeParse(validSignals()).success).toBe(true);
    expect(
      PAGE_SIGNALS_SCHEMA.safeParse({ ...validSignals(), jsonLd: [{ bogus: true }] }).success,
    ).toBe(false);
    expect(
      PROVIDER_CAPABILITIES_SCHEMA.safeParse({
        video: false,
        webGrounding: true,
        segmentation: false,
        structuredOutput: 'json_schema',
      }).success,
    ).toBe(true);
    expect(
      PROVIDER_CAPABILITIES_SCHEMA.safeParse({
        video: false,
        webGrounding: true,
        segmentation: false,
        structuredOutput: 'xml',
      }).success,
    ).toBe(false);
  });
});
