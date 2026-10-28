import type { PlaceResult } from './types';
import type { GuideSource, Usage } from './providers/index';
import { createMutex } from './utils/mutex';

const MAX_PREVIEW_DATA_URL = 2000000;
const CACHE_SLOTS = 10;
const CACHE_INDEX_KEY = 'cacheKeys';

export interface CacheEntry {
  place: PlaceResult;
  guide: string;
  sources: GuideSource[];
  usage: Usage;
  searchedWeb: boolean;
}

export const isAllowedPreviewUrl = (srcUrl: string): boolean => {
  if (srcUrl.startsWith('data:')) {
    return srcUrl.length <= MAX_PREVIEW_DATA_URL && srcUrl.startsWith('data:image/');
  }

  try {
    const parsed = new URL(srcUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

export const hashCacheKey = async (srcUrl: string, pageUrl: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${srcUrl}|${pageUrl}`)
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const cacheKeyFor = (hash: string): string => `cache:${hash}`;

const isCacheEntry = (value: unknown): value is CacheEntry => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as Partial<CacheEntry>;
  return (
    typeof entry.guide === 'string' &&
    Array.isArray(entry.sources) &&
    !!entry.place &&
    typeof entry.place === 'object' &&
    typeof (entry.place as PlaceResult).placeName === 'string' &&
    !!entry.usage &&
    typeof entry.usage === 'object'
  );
};

const readCacheIndex = async (): Promise<string[]> => {
  try {
    const stored = (await chrome.storage.session.get(CACHE_INDEX_KEY)) as {
      cacheKeys?: unknown;
    };

    return Array.isArray(stored.cacheKeys)
      ? stored.cacheKeys.filter((key): key is string => typeof key === 'string')
      : [];
  } catch {
    return [];
  }
};

const cacheMutex = createMutex();

export const getCacheEntry = async (hash: string): Promise<CacheEntry | undefined> =>
  cacheMutex(async () => {
    try {
      const stored = (await chrome.storage.session.get(cacheKeyFor(hash))) as Record<
        string,
        unknown
      >;
      const entry = stored[cacheKeyFor(hash)];

      if (!isCacheEntry(entry)) {
        return undefined;
      }

      const index = (await readCacheIndex()).filter((key) => key !== hash);
      index.unshift(hash);

      await chrome.storage.session.set({ [CACHE_INDEX_KEY]: index.slice(0, CACHE_SLOTS) });
      return entry;
    } catch {
      return undefined;
    }
  });

export const setCacheEntry = async (hash: string, entry: CacheEntry): Promise<void> =>
  cacheMutex(async () => {
    try {
      await chrome.storage.session.set({ [cacheKeyFor(hash)]: entry });

      const index = (await readCacheIndex()).filter((key) => key !== hash);

      index.unshift(hash);

      const evicted = index.slice(CACHE_SLOTS);

      await chrome.storage.session.set({ [CACHE_INDEX_KEY]: index.slice(0, CACHE_SLOTS) });

      for (const key of evicted) {
        await chrome.storage.session.remove(cacheKeyFor(key));
      }
    } catch {
      // Cache writes are best-effort; a failure never breaks the analysis.
    }
  });
