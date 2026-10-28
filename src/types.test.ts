import { describe, expect, it } from 'vitest';
import {
  PAGE_SIGNALS_SCHEMA,
  PLACE_SCHEMA,
  PROVIDER_CAPABILITIES_SCHEMA,
  TRIP_REQUEST_SCHEMA,
  alternatesJsonSchema,
  alternatesSchema,
  duelJsonSchema,
  duelSchema,
  itineraryJsonSchema,
  itinerarySchema,
  placeJsonSchema,
  scanBatchJsonSchema,
  scanPlaceSchema,
} from './types';

const forbiddenKeys = (value: unknown, path = '$'): string[] => {
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
};

const assertStrictSubset = (schema: Record<string, unknown>, path = '$'): void => {
  expect(schema.type, `${path} is an object`).toBe('object');
  expect(schema.additionalProperties, `${path} forbids extra keys`).toBe(false);
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const required = schema.required as string[];
  expect([...required].sort(), `${path} requires every property`).toEqual(
    Object.keys(props).sort()
  );
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === 'string' && !Array.isArray(prop.enum)) {
      expect(typeof prop.maxLength, `${path}.${name} has maxLength`).toBe('number');
    }
    if (prop.type === 'object') {
      assertStrictSubset(prop, `${path}.${name}`);
    }
    if (prop.type === 'array') {
      const items = prop.items as Record<string, unknown>;
      if (items.type === 'object') {
        assertStrictSubset(items, `${path}.${name}[]`);
      }
    }
  }
};

const VALID_PLACE = {
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.9,
  oneLiner: 'Blue domes over the caldera.',
};

const validSignals = () => {
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
};

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
    expect(PLACE_SCHEMA.safeParse({ ...VALID_PLACE, placeName: 'x'.repeat(101) }).success).toBe(
      false
    );
    expect(PLACE_SCHEMA.safeParse({ ...VALID_PLACE, identified: 'yes' }).success).toBe(false);
    expect(PLACE_SCHEMA.safeParse({ ...VALID_PLACE, confidence: 'high' }).success).toBe(false);
    const { country: _dropped, ...missingCountry } = VALID_PLACE;
    expect(PLACE_SCHEMA.safeParse(missingCountry).success).toBe(false);
    expect(PLACE_SCHEMA.safeParse({ ...VALID_PLACE, extra: 1 }).success).toBe(false);
  });
});

describe('itinerary schema pipeline', () => {
  const STOPS = ['Oia', 'Fira'];

  it('emits the strict subset with inlined stop enums', () => {
    const schema = itineraryJsonSchema(STOPS);
    assertStrictSubset(schema);
    expect(forbiddenKeys(schema)).toEqual([]);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const stopsItems = props.stops.items as Record<string, unknown>;
    expect(stopsItems.enum).toEqual(STOPS);
  });

  it('accepts a valid plan and constrains every stop to the enum', () => {
    const schema = itinerarySchema(STOPS);
    const valid = {
      stops: ['Oia', 'Fira'],
      days: [{ dayTitle: 'Day 1', stopNames: ['Oia'], summary: 'Caldera views.' }],
      nightsEach: [
        { stop: 'Oia', nights: 2 },
        { stop: 'Fira', nights: 1 },
      ],
    };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, stops: ['Oia', 'Paris'] }).success).toBe(false);
    expect(
      schema.safeParse({
        ...valid,
        days: [{ dayTitle: 'Day 1', stopNames: ['Paris'], summary: 'Nope.' }],
      }).success
    ).toBe(false);
  });

  it('rejects oversized strings and refuses an empty enum', () => {
    const schema = itinerarySchema(STOPS);
    expect(
      schema.safeParse({
        stops: ['Oia'],
        days: [{ dayTitle: 'x'.repeat(81), stopNames: ['Oia'], summary: 'Ok.' }],
        nightsEach: [],
      }).success
    ).toBe(false);
    expect(() => itinerarySchema([])).toThrow();
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
        .success
    ).toBe(true);
    // Worker contract: every record shape the worker writes must parse.
    // Failed scrapes, page scans, and quota-slimmed retries omit `signals`
    // entirely rather than writing a partial object. Records carry the
    // source window so foreign panels ignore them.
    expect(TRIP_REQUEST_SCHEMA.safeParse({ ...collecting, status: 'ready' }).success).toBe(true);
    expect(
      TRIP_REQUEST_SCHEMA.safeParse({ ...collecting, status: 'ready', windowId: 2 }).success
    ).toBe(true);
    expect(
      TRIP_REQUEST_SCHEMA.safeParse({
        ...collecting,
        status: 'ready',
        srcUrl: '',
        scanImages: [
          { url: 'https://cdn.example.com/a.jpg', caption: '', heading: '', width: 1, height: 1 },
        ],
      }).success
    ).toBe(true);
    expect(TRIP_REQUEST_SCHEMA.safeParse({ ...collecting, status: 'bogus' }).success).toBe(false);
    expect(TRIP_REQUEST_SCHEMA.safeParse({ ...collecting, signals: {} }).success).toBe(false);
    expect(
      TRIP_REQUEST_SCHEMA.safeParse({ ...collecting, signals: { ...validSignals(), alt: 42 } })
        .success
    ).toBe(false);
  });

  it('validates page signals and capabilities', () => {
    expect(PAGE_SIGNALS_SCHEMA.safeParse(validSignals()).success).toBe(true);
    expect(
      PAGE_SIGNALS_SCHEMA.safeParse({ ...validSignals(), jsonLd: [{ bogus: true }] }).success
    ).toBe(false);
    expect(
      PROVIDER_CAPABILITIES_SCHEMA.safeParse({
        video: false,
        webGrounding: true,
        segmentation: false,
        structuredOutput: 'json_schema',
      }).success
    ).toBe(true);
    expect(
      PROVIDER_CAPABILITIES_SCHEMA.safeParse({
        video: false,
        webGrounding: true,
        segmentation: false,
        structuredOutput: 'xml',
      }).success
    ).toBe(false);
  });
});

describe('scan batch pipeline', () => {
  it('emits the strict subset with a bounded index', () => {
    const schema = scanBatchJsonSchema();
    assertStrictSubset(schema);
    expect(forbiddenKeys(schema)).toEqual([]);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const items = props.places.items as Record<string, unknown>;
    const itemProps = items.properties as Record<string, unknown>;
    expect(itemProps.imageIndex).toMatchObject({ type: 'integer', minimum: 0, maximum: 11 });
  });

  it('validates scan entries and rejects bad indices', () => {
    const schema = scanPlaceSchema();
    const valid = {
      placeName: 'Oia',
      city: 'Oia',
      country: 'Greece',
      confidence: 0.9,
      imageIndex: 3,
    };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, imageIndex: 12 }).success).toBe(false);
    expect(schema.safeParse({ ...valid, imageIndex: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...valid, imageIndex: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...valid, placeName: 'x'.repeat(101) }).success).toBe(false);
  });
});

describe('duel pipeline', () => {
  it('emits the strict subset', () => {
    const schema = duelJsonSchema();
    assertStrictSubset(schema);
    expect(forbiddenKeys(schema)).toEqual([]);
  });

  it('validates verdicts and rejects oversized strings', () => {
    const schema = duelSchema();
    const valid = {
      criteria: [{ criterion: 'Cost', a: 'Pricey sunsets.', b: 'Cheaper stays.' }],
      verdict: 'Pick Oia for views, Fira for budget.',
    };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, verdict: 'x'.repeat(301) }).success).toBe(false);
    expect(
      schema.safeParse({
        ...valid,
        criteria: [{ criterion: 'x'.repeat(41), a: 'a', b: 'b' }],
      }).success
    ).toBe(false);
  });
});

describe('alternates pipeline', () => {
  it('emits the strict subset', () => {
    const schema = alternatesJsonSchema();
    assertStrictSubset(schema);
    expect(forbiddenKeys(schema)).toEqual([]);
  });

  it('validates alternatives and rejects oversized strings', () => {
    const schema = alternatesSchema();
    const valid = {
      alternatives: [
        {
          placeName: 'Fira',
          country: 'Greece',
          why: 'Same caldera, lower prices.',
          bestMonth: 'May',
        },
      ],
    };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(
      schema.safeParse({
        alternatives: [{ ...valid.alternatives[0], bestMonth: 'x'.repeat(21) }],
      }).success
    ).toBe(false);
  });
});
