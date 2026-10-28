import * as z from 'zod/mini';
import { CACHE_ENTRY_SCHEMA, PROMPT_VERSION } from './types';
import { sendCommand } from './storage_client';

const MAX_PREVIEW_DATA_URL = 2000000;

export const CACHE_SLOTS = 10;

export const CACHE_INDEX_KEY = 'cacheKeys';

export const CACHE_ENTRY_VERSION = 1;

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
  providerId: string;
  endpoint: string;
  model: string;
  imageOnly: boolean;
}

// Identify-cache identity: schema/prompt version, provider, normalized
// endpoint, model, image-only mode, and media identity. Everything hashes;
// raw identity fields are never stored.
export const hashIdentifyKey = async (parts: IdentifyKeyParts): Promise<string> =>
  hashFields([
    String(CACHE_VERSION),
    'identify',
    String(PROMPT_VERSION),
    parts.providerId,
    parts.endpoint,
    parts.model,
    parts.imageOnly ? 'image-only' : 'full',
    parts.mediaSeed,
    parts.pageUrl,
  ]);

// Guide-cache identity derives from the identify key plus destination,
// effective language, and grounding mode, so a language or cheap-mode
// switch re-guides without re-identifying.
export const hashGuideKey = async (
  identifyKey: string,
  destination: string,
  language: string,
  grounded: boolean
): Promise<string> =>
  hashFields([
    String(CACHE_VERSION),
    'guide',
    String(PROMPT_VERSION),
    identifyKey,
    destination,
    language,
    grounded ? 'grounded' : 'chat',
  ]);

const hashFields = async (fields: string[]): Promise<string> => {
  const encoded = fields.map((field) => `${field.length}:${field}`).join('');

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded));

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// Endpoint normalization for cache identity: the fixed Muse host folds to
// one value; custom endpoints normalize to origin plus path so equivalent
// spellings share entries.
export const normalizeEndpoint = (providerId: string, baseURL: string): string => {
  if (providerId !== 'openai_compat') {
    return 'muse';
  }

  try {
    const parsed = new URL(baseURL);

    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return baseURL;
  }
};

export const cacheKeyFor = (hash: string): string => `cache:${hash}`;

const parseEntry = (value: unknown): CacheEntry | undefined => {
  const parsed = CACHE_ENTRY_SCHEMA.safeParse(value);

  return parsed.success ? parsed.data : undefined;
};

export const unwrapEntry = (value: unknown): CacheEntry | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if ('entry' in value) {
    const record = value as { v?: unknown; entry?: unknown };

    return record.v === CACHE_ENTRY_VERSION ? parseEntry(record.entry) : undefined;
  }

  return parseEntry(value);
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
