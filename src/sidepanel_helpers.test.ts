import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getCacheEntry,
  hashCacheKey,
  isAllowedPreviewUrl,
  setCacheEntry,
  type CacheEntry,
} from './result_cache';
import { isLoopbackHttp } from './sidepanel';
import { installChromeMock, uninstallChromeMock } from './test/chrome_mock';

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
  installChromeMock();
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
  it('hashes deterministically to 64 hex chars', async () => {
    const first = await hashCacheKey('https://cdn.example.com/oia.jpg', 'https://example.com/g');
    const second = await hashCacheKey('https://cdn.example.com/oia.jpg', 'https://example.com/g');
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await hashCacheKey('https://cdn.example.com/other.jpg', 'https://example.com/g')
    ).not.toBe(first);
  });
});

describe('session result cache', () => {
  it('round-trips entries and evicts past ten', async () => {
    for (let n = 0; n < 11; n += 1) {
      await setCacheEntry(`hash${n}`, entry(`Place${n}`));
    }
    expect(await getCacheEntry('hash0')).toBeUndefined();
    expect((await getCacheEntry('hash10'))?.place.placeName).toBe('Place10');
  });

  it('treats corrupt entries as misses', async () => {
    const { local: _local, session } = installChromeMock();
    await session.set({ 'cache:bad': { nope: true } });
    expect(await getCacheEntry('bad')).toBeUndefined();
  });
});
