// Command protocol for the worker-owned storage service. Pages send intents;
// the worker validates, serializes, and executes them against chrome.storage
// as the single writer. Schemas bound shape and size; semantic checks
// (non-empty, finite) live with the handlers so error text stays stable.
import * as z from 'zod/mini';
import { CACHE_ENTRY_SCHEMA, PLACE_SCHEMA } from './types';

export const STORAGE_MESSAGE_SCOPE = 'take-me-there/storage-v1';

export const isExtensionPageSender = (sender: chrome.runtime.MessageSender): boolean => {
  if (sender.id !== undefined && sender.id !== chrome.runtime.id) {
    return false;
  }

  const url = sender.url ?? '';

  return url.startsWith(chrome.runtime.getURL(''));
};

const pinSchema = z.strictObject({
  place: PLACE_SCHEMA,
  sourceHost: z.string().check(z.maxLength(256)),
  thumbnail: z.optional(z.string().check(z.maxLength(100000))),
  imageUrl: z.optional(z.string().check(z.maxLength(8000))),
  addedAt: z.optional(z.number()),
});

const placeRefSchema = z.strictObject({
  placeName: z.string().check(z.maxLength(100)),
  country: z.string().check(z.maxLength(100)),
});

const boardMoveSchema = z.strictObject({
  placeName: z.string().check(z.maxLength(100)),
  country: z.string().check(z.maxLength(100)),
  direction: z.enum(['up', 'down']),
});

const itinerarySaveSchema = z.strictObject({
  pinIds: z.array(z.string().check(z.maxLength(128))),
  markdown: z.string().check(z.maxLength(300000)),
});

const spendRecordSchema = z.strictObject({
  amountUsd: z.number(),
  at: z.number(),
});

const spendResetSchema = z.strictObject({
  at: z.number(),
});

const cacheEntrySchema = CACHE_ENTRY_SCHEMA;

const cacheKeySchema = z.strictObject({
  hash: z.string().check(z.maxLength(128)),
});

const cacheSetSchema = z.strictObject({
  hash: z.string().check(z.maxLength(128)),
  entry: cacheEntrySchema,
});

const settingsSchema = z.strictObject({
  activeProviderId: z.string().check(z.maxLength(64)),
  openaiCompat: z.strictObject({
    baseURL: z.string().check(z.maxLength(2000)),
    model: z.string().check(z.maxLength(200)),
  }),
  imageOnly: z.boolean(),
  sessionOnly: z.boolean(),
  skipWebSearch: z.boolean(),
  cacheTtlDays: z.number(),
});

const providerSchema = z.strictObject({
  providerId: z.string().check(z.maxLength(64)),
});

const keySaveSchema = z.strictObject({
  providerId: z.string().check(z.maxLength(64)),
  key: z.string().check(z.maxLength(4000)),
  sessionOnly: z.boolean(),
});

const keyModeSchema = z.strictObject({
  providerId: z.string().check(z.maxLength(64)),
  sessionOnly: z.boolean(),
});

const emptySchema = z.strictObject({});

export type StorageCommand =
  | { kind: 'board.add'; pin: z.infer<typeof pinSchema> }
  | { kind: 'board.remove'; placeName: string; country: string }
  | { kind: 'board.move'; placeName: string; country: string; direction: 'up' | 'down' }
  | { kind: 'board.clear' }
  | { kind: 'itinerary.save'; pinIds: string[]; markdown: string }
  | { kind: 'itinerary.clear' }
  | { kind: 'spend.record'; amountUsd: number; at: number }
  | { kind: 'spend.reset'; at: number }
  | { kind: 'cache.get'; hash: string }
  | { kind: 'cache.set'; hash: string; entry: z.infer<typeof cacheEntrySchema> }
  | { kind: 'cache.clear' }
  | { kind: 'settings.save'; settings: z.infer<typeof settingsSchema> }
  | { kind: 'key.save'; providerId: string; key: string; sessionOnly: boolean }
  | { kind: 'key.clear'; providerId: string }
  | { kind: 'key.clearAll' }
  | { kind: 'key.setMode'; providerId: string; sessionOnly: boolean }
  | { kind: 'migrate.run' };

export type CommandKind = StorageCommand['kind'];

export interface StorageMessage {
  scope: string;
  command: StorageCommand;
}

export type CommandResult =
  { ok: true; value: unknown } | { ok: false; error: string; value?: unknown };

interface PayloadSchema {
  safeParse(payload: unknown): { success: boolean; data?: unknown };
}

export const COMMAND_SCHEMAS: Record<CommandKind, PayloadSchema> = {
  'board.add': z.strictObject({ pin: pinSchema }),
  'board.remove': placeRefSchema,
  'board.move': boardMoveSchema,
  'board.clear': emptySchema,
  'itinerary.save': itinerarySaveSchema,
  'itinerary.clear': emptySchema,
  'spend.record': spendRecordSchema,
  'spend.reset': spendResetSchema,
  'cache.get': cacheKeySchema,
  'cache.set': cacheSetSchema,
  'cache.clear': emptySchema,
  'settings.save': z.strictObject({ settings: settingsSchema }),
  'key.save': keySaveSchema,
  'key.clear': providerSchema,
  'key.clearAll': emptySchema,
  'key.setMode': keyModeSchema,
  'migrate.run': emptySchema,
};

export const commandPayload = (command: StorageCommand): unknown => {
  const { kind: _kind, ...payload } = command;

  return payload;
};
