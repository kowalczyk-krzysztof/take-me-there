import type { PlaceResult } from './types';
import type { GuideSource, Usage } from './providers/index';
import { createMutex } from './utils/mutex';

const MAX_PREVIEW_DATA_URL = 2000000;

const CACHE_SLOTS = 10;

const CACHE_INDEX_KEY = 'cacheKeys';

const CACHE_ENTRY_VERSION = 1;

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

export const CACHE_VERSION = 1;

export interface CacheKeyParts {
  seed: string;
  pageUrl: string;
  providerId: string;
  model: string;
  imageOnly: boolean;
}

export const hashCacheKey = async (parts: CacheKeyParts): Promise<string> => {
  const fields = [
    String(CACHE_VERSION),
    parts.providerId,
    parts.model,
    parts.imageOnly ? 'image-only' : 'full',
    parts.seed,
    parts.pageUrl,
  ];

  const encoded = fields.map((field) => `${field.length}:${field}`).join('');

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded));

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const cacheKeyFor = (hash: string): string => `cache:${hash}`;

const isBareEntry = (value: unknown): value is CacheEntry => {
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

const unwrapEntry = (value: unknown): CacheEntry | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if ('entry' in value) {
    const record = value as { v?: unknown; entry?: unknown };

    return record.v === CACHE_ENTRY_VERSION && isBareEntry(record.entry)
      ? (record.entry as CacheEntry)
      : undefined;
  }

  return isBareEntry(value) ? (value as CacheEntry) : undefined;
};

const readCacheIndex = async (): Promise<string[]> => {
  try {
    const stored = (await chrome.storage.local.get(CACHE_INDEX_KEY)) as {
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
      const stored = (await chrome.storage.local.get(cacheKeyFor(hash))) as Record<string, unknown>;

      const entry = unwrapEntry(stored[cacheKeyFor(hash)]);

      if (!entry) {
        return undefined;
      }

      const index = (await readCacheIndex()).filter((key) => key !== hash);
      index.unshift(hash);

      await chrome.storage.local.set({ [CACHE_INDEX_KEY]: index.slice(0, CACHE_SLOTS) });

      return entry;
    } catch {
      return undefined;
    }
  });

export const setCacheEntry = async (hash: string, entry: CacheEntry): Promise<void> =>
  cacheMutex(async () => {
    try {
      await chrome.storage.local.set({
        [cacheKeyFor(hash)]: { v: CACHE_ENTRY_VERSION, entry },
      });

      const index = (await readCacheIndex()).filter((key) => key !== hash);

      index.unshift(hash);

      const evicted = index.slice(CACHE_SLOTS);

      await chrome.storage.local.set({ [CACHE_INDEX_KEY]: index.slice(0, CACHE_SLOTS) });

      for (const key of evicted) {
        await chrome.storage.local.remove(cacheKeyFor(key));
      }
    } catch {
      // Cache writes are best-effort; a failure never breaks the analysis.
    }
  });
