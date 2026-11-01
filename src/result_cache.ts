import * as z from 'zod/mini';
import { CACHE_ENTRY_SCHEMA, PROMPT_VERSION } from './types';
import { sendCommand } from './storage_client';

const MAX_PREVIEW_DATA_URL = 2000000;

export const CACHE_SLOTS = 10;

export const CACHE_INDEX_KEY = 'cacheKeys';

export const CACHE_ENTRY_VERSION = 2;

// Session-held entries expire a week after creation.
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Total cache bytes: a conservative share of the 10 MB session quota.
// Identify-only entries are small, so the slot cap binds first; the byte
// cap stays as defense-in-depth.
export const CACHE_MAX_BYTES = 2 * 1024 * 1024;

export type CacheEntry = z.infer<typeof CACHE_ENTRY_SCHEMA>;

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

export const CACHE_VERSION = 2;

export interface IdentifyKeyParts {
  mediaSeed: string;
  pageUrl: string;
  imageOnly: boolean;
}

// Identify-cache identity: schema/prompt version, image-only mode, and
// media identity. Everything hashes; raw identity fields are never stored.
export const hashIdentifyKey = async (parts: IdentifyKeyParts): Promise<string> =>
  hashFields([
    String(CACHE_VERSION),
    'identify',
    String(PROMPT_VERSION),
    parts.imageOnly ? 'image-only' : 'full',
    parts.mediaSeed,
    parts.pageUrl,
  ]);

const hashFields = async (fields: string[]): Promise<string> => {
  const encoded = fields.map((field) => `${field.length}:${field}`).join('');

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded));

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export const cacheKeyFor = (hash: string): string => `cache:${hash}`;

export interface CacheRecord {
  v: number;
  entry: CacheEntry;
  createdAt: number;
}

const parseRecord = (value: unknown): CacheRecord | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as { v?: unknown; entry?: unknown; createdAt?: unknown };

  if (record.v !== CACHE_ENTRY_VERSION) {
    return undefined;
  }

  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) {
    return undefined;
  }

  const parsed = CACHE_ENTRY_SCHEMA.safeParse(record.entry);

  if (!parsed.success) {
    return undefined;
  }

  return { v: CACHE_ENTRY_VERSION, entry: parsed.data, createdAt: record.createdAt };
};

export const unwrapRecord = (value: unknown): CacheRecord | undefined => parseRecord(value);

export const unwrapEntry = (value: unknown): CacheEntry | undefined => parseRecord(value)?.entry;

export const readCacheIndex = async (): Promise<string[]> => {
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

// The bundled Chrome types omit the documented get(null) whole-area
// form; the cast recovers it.
const getAllLocal = async (): Promise<Record<string, unknown>> =>
  (await chrome.storage.local.get(null as unknown as string)) as unknown as Record<string, unknown>;

// Upgrade purge: legacy result-cache records lived in local storage; the
// session-default cache starts empty. Restricted to the cache namespace:
// keys, settings, and cost history are never touched. Throws on
// failure so the migration framework reports and retries it.
export const migrateCache = async (): Promise<void> => {
  const stored = await getAllLocal();

  const stale = Object.keys(stored).filter(
    (key) => key === CACHE_INDEX_KEY || key.startsWith('cache:')
  );

  if (stale.length === 0) {
    return;
  }

  await chrome.storage.local.remove(stale);
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

// Clears indexed and orphaned entries through the shared storage owner.
// Returns the removed entry count; throws when the clear itself fails so
// callers never report a failed cleanup as successful.
export const clearCacheEntries = async (): Promise<number> =>
  sendCommand<number>({ kind: 'cache.clear' });
