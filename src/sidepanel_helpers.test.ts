import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CACHE_TTL_MS,
  clearCacheEntries,
  getCacheEntry,
  hashIdentifyKey,
  isAllowedPreviewUrl,
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
  usage: { inputTokens: 1, outputTokens: 1, searchCount: 0, flatFeesUsd: 0 },
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

  it('scopes keys by media, page, and image-only mode', async () => {
    const base = await hashIdentifyKey(parts);
    expect(
      await hashIdentifyKey({ ...parts, mediaSeed: 'https://cdn.example.com/other.jpg' })
    ).not.toBe(base);
    expect(await hashIdentifyKey({ ...parts, pageUrl: 'https://example.com/h' })).not.toBe(base);
    expect(await hashIdentifyKey({ ...parts, imageOnly: true })).not.toBe(base);
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

  it('stores versioned timestamped envelopes in session storage', async () => {
    const mock = installChromeMock();
    routeWorkerMessages(mock);
    await setCacheEntry('hash0', entry('Place0'));
    const stored = mock.session.data.get('cache:hash0') as {
      v: number;
      createdAt: number;
      entry: CacheEntry;
    };
    expect(stored.v).toBe(2);
    expect(stored.createdAt).toEqual(expect.any(Number));
    expect(stored.entry.place.placeName).toBe('Place0');
    expect(mock.local.data.has('cache:hash0')).toBe(false);
  });

  it('rejects bare entries and unknown versions', async () => {
    const mock = installChromeMock();
    routeWorkerMessages(mock);
    await mock.session.set({ 'cache:bare': entry('Bare') });
    await mock.session.set({
      'cache:future': { v: 99, entry: entry('Future'), createdAt: Date.now() },
    });
    expect(await getCacheEntry('bare')).toBeUndefined();
    expect(await getCacheEntry('future')).toBeUndefined();
  });

  it('treats corrupt entries as misses', async () => {
    const mock = installChromeMock();
    routeWorkerMessages(mock);
    const { session } = mock;
    await session.set({ 'cache:bad': { nope: true } });
    expect(await getCacheEntry('bad')).toBeUndefined();
  });

  it('expires entries after seven days and deletes them', async () => {
    const mock = installChromeMock();
    routeWorkerMessages(mock);
    await mock.session.set({
      'cache:old': { v: 2, entry: entry('Old'), createdAt: Date.now() - CACHE_TTL_MS - 1000 },
      cacheKeys: ['old'],
    });
    expect(await getCacheEntry('old')).toBeUndefined();
    expect(mock.session.data.has('cache:old')).toBe(false);
  });

  it('loses the cache with the browser session', async () => {
    const mock = installChromeMock();
    routeWorkerMessages(mock);
    await setCacheEntry('hash0', entry('Place0'));
    expect((await getCacheEntry('hash0'))?.place.placeName).toBe('Place0');
    await mock.session.clear();
    expect(await getCacheEntry('hash0')).toBeUndefined();
  });

  it('clears indexed and orphaned entries and reports the count', async () => {
    const mock = installChromeMock();
    routeWorkerMessages(mock);
    await setCacheEntry('hash0', entry('Place0'));
    await mock.session.set({
      'cache:orphan': { v: 2, entry: entry('Orphan'), createdAt: Date.now() },
    });
    await mock.session.set({ unrelated: 'keep-me' });
    expect(await clearCacheEntries()).toBe(2);
    expect(await getCacheEntry('hash0')).toBeUndefined();
    expect(mock.session.data.get('unrelated')).toBe('keep-me');
    expect([...mock.session.data.keys()].filter((key) => key.startsWith('cache:'))).toEqual([]);
  });
});
