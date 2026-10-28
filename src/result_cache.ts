import type { PlaceResult } from './types';
import type { GuideSource, Usage } from './providers/index';
import { sendCommand } from './storage_client';

const MAX_PREVIEW_DATA_URL = 2000000;

export const CACHE_SLOTS = 10;

export const CACHE_INDEX_KEY = 'cacheKeys';

export const CACHE_ENTRY_VERSION = 1;

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

export const cacheKeyFor = (hash: string): string => `cache:${hash}`;

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

export const unwrapEntry = (value: unknown): CacheEntry | undefined => {
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

export const readCacheIndex = async (): Promise<string[]> => {
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

export const getCacheEntry = async (hash: string): Promise<CacheEntry | undefined> => {
  try {
    return await sendCommand<CacheEntry | undefined>({ kind: 'cache.get', hash });
  } catch {
    return undefined;
  }
};

export const setCacheEntry = async (hash: string, entry: CacheEntry): Promise<void> => {
  try {
    await sendCommand<void>({ kind: 'cache.set', hash, entry });
  } catch {
    // Cache writes are best-effort; a failure never breaks the analysis.
  }
};
