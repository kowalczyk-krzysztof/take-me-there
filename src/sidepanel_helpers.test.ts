import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getCacheEntry,
  hashGuideKey,
  hashIdentifyKey,
  isAllowedPreviewUrl,
  normalizeEndpoint,
  setCacheEntry,
  type CacheEntry,
  type IdentifyKeyParts,
} from './result_cache';
import { isLoopbackHttp } from './sidepanel';
import { installChromeMock, uninstallChromeMock } from './test/chrome_mock';
import { routeWorkerMessages } from './test/helpers';

describe('isLoopbackHttp', () => {
  it('matches http loopback hosts only', () => {
    expect(isLoopbackHttp('http://localhost:8000/oia.jpg')).toBe(true);
    expect(isLoopbackHttp('http://127.0.0.1/oia.jpg')).toBe(true);
    expect(isLoopbackHttp('http://[::1]/oia.jpg')).toBe(true);
    expect(isLoopbackHttp('https://localhost/oia.jpg')).toBe(false);
    expect(isLoopbackHttp('http://example.com/oia.jpg')).toBe(false);
    expect(isLoopbackHttp('https://cdn.example.com/oia.jpg')).toBe(false);
    expect(isLoopbackHttp('not a url')).toBe(false);
  });
});

beforeEach(() => {
  routeWorkerMessages(installChromeMock());
});

afterEach(() => {
  uninstallChromeMock();
});

const entry = (name: string): CacheEntry => ({
  place: {
    identified: true,
    placeName: name,
    city: '',
    country: '',
    confidence: 1,
    oneLiner: '',
  },
  guide: `${name} guide.`,
  sources: [],
  usage: { inputTokens: 1, outputTokens: 1, searchCount: 0, flatFeesUsd: 0 },
  searchedWeb: false,
});

describe('preview allowlist', () => {
  it.each([
    ['https://cdn.example.com/oia.jpg', true],
    ['http://cdn.example.com/oia.jpg', true],
    ['data:image/png;base64,iVBORw0KGgo=', true],
    ['data:image/svg+xml,<svg></svg>', true],
    [`data:image/png;base64,${'a'.repeat(3_000_000)}`, false],
    ['data:text/html,<p>hi</p>', false],
    ['javascript:alert(1)', false],
    ['blob:https://example.com/uuid', false],
    ['ftp://files.example.com/x.jpg', false],
    ['/relative/path.jpg', false],
    ['', false],
  ])('allows %s: %s', (url, allowed) => {
    expect(isAllowedPreviewUrl(url as string)).toBe(allowed as boolean);
  });
});

describe('cache key hashing', () => {
  const parts: IdentifyKeyParts = {
    mediaSeed: 'https://cdn.example.com/oia.jpg',
    pageUrl: 'https://example.com/g',
    providerId: 'muse',
    endpoint: normalizeEndpoint('muse', ''),
    model: 'muse-spark-1.3',
    imageOnly: false,
  };

  it('hashes deterministically to 64 hex chars', async () => {
    const first = await hashIdentifyKey(parts);

    const second = await hashIdentifyKey(parts);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await hashIdentifyKey({ ...parts, mediaSeed: 'https://cdn.example.com/other.jpg' })
    ).not.toBe(first);
  });

  it('scopes keys by provider, endpoint, model, and image-only mode', async () => {
    const base = await hashIdentifyKey(parts);
    expect(await hashIdentifyKey({ ...parts, providerId: 'openai_compat' })).not.toBe(base);
    expect(
      await hashIdentifyKey({
        ...parts,
        providerId: 'openai_compat',
        endpoint: normalizeEndpoint('openai_compat', 'https://llm.example.com/v1'),
      })
    ).not.toBe(base);
    expect(await hashIdentifyKey({ ...parts, model: 'other-model' })).not.toBe(base);
    expect(await hashIdentifyKey({ ...parts, imageOnly: true })).not.toBe(base);
  });

  it('normalizes equivalent custom endpoints together', () => {
    expect(normalizeEndpoint('muse', '')).toBe('muse');
    expect(normalizeEndpoint('openai_compat', 'https://LLM.example.com/v1/')).toBe(
      normalizeEndpoint('openai_compat', 'https://llm.example.com/v1')
    );
    expect(normalizeEndpoint('openai_compat', 'https://llm.example.com/v1')).not.toBe(
      normalizeEndpoint('openai_compat', 'https://llm.example.com/v2')
    );
    expect(normalizeEndpoint('openai_compat', 'not a url')).toBe('not a url');
  });

  it('keys guides off identify plus destination, language, and grounding', async () => {
    const identify = await hashIdentifyKey(parts);
    const base = await hashGuideKey(identify, 'Oia, Greece', 'en-US', true);
    expect(await hashGuideKey(identify, 'Oia, Greece', 'en-US', true)).toBe(base);
    expect(
      await hashGuideKey(
        await hashIdentifyKey({ ...parts, model: 'other' }),
        'Oia, Greece',
        'en-US',
        true
      )
    ).not.toBe(base);
    expect(await hashGuideKey(identify, 'Fira, Greece', 'en-US', true)).not.toBe(base);
    expect(await hashGuideKey(identify, 'Oia, Greece', 'de', true)).not.toBe(base);
    expect(await hashGuideKey(identify, 'Oia, Greece', 'en-US', false)).not.toBe(base);
  });

  it('keeps query-selected videos apart', async () => {
    const a = await hashIdentifyKey({ ...parts, mediaSeed: 'https://example.com/video?id=A#t=1' });
    const b = await hashIdentifyKey({ ...parts, mediaSeed: 'https://example.com/video?id=B#t=1' });
    expect(a).not.toBe(b);
  });
});

describe('persistent result cache', () => {
  it('round-trips entries and evicts past ten', async () => {
    for (let n = 0; n < 11; n += 1) {
      await setCacheEntry(`hash${n}`, entry(`Place${n}`));
    }
    expect(await getCacheEntry('hash0')).toBeUndefined();
    expect((await getCacheEntry('hash10'))?.place.placeName).toBe('Place10');
  });

  it('stores versioned envelopes in local storage', async () => {
    const mock = installChromeMock();
    routeWorkerMessages(mock);
    await setCacheEntry('hash0', entry('Place0'));
    const stored = mock.local.data.get('cache:hash0') as { v: number; entry: CacheEntry };
    expect(stored.v).toBe(1);
    expect(stored.entry.place.placeName).toBe('Place0');
    expect(mock.session.data.has('cache:hash0')).toBe(false);
  });

  it('accepts legacy bare entries but rejects unknown versions', async () => {
    const mock = installChromeMock();
    routeWorkerMessages(mock);
    await mock.local.set({ 'cache:bare': entry('Bare') });
    await mock.local.set({ 'cache:future': { v: 99, entry: entry('Future') } });
    expect((await getCacheEntry('bare'))?.place.placeName).toBe('Bare');
    expect(await getCacheEntry('future')).toBeUndefined();
  });

  it('treats corrupt entries as misses', async () => {
    const mock = installChromeMock();
    routeWorkerMessages(mock);
    const { local } = mock;
    await local.set({ 'cache:bad': { nope: true } });
    expect(await getCacheEntry('bad')).toBeUndefined();
  });
});
