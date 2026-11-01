// Command protocol for the worker-owned storage service. Pages send intents;
// the worker validates, serializes, and executes them against chrome.storage
// as the single writer. Schemas bound shape and size; semantic checks
// (non-empty, finite) live with the handlers so error text stays stable.
import * as z from 'zod/mini';
import { CACHE_ENTRY_SCHEMA } from './types';

export const STORAGE_MESSAGE_SCOPE = 'take-me-there/storage-v1';

export const isExtensionPageSender = (sender: chrome.runtime.MessageSender): boolean => {
  if (sender.id !== undefined && sender.id !== chrome.runtime.id) {
    return false;
  }

  const url = sender.url ?? '';

  return url.startsWith(chrome.runtime.getURL(''));
};

const spendRecordSchema = z.strictObject({
  amountUsd: z.number(),
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
  | { kind: 'spend.record'; amountUsd: number; at: number }
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
  'spend.record': spendRecordSchema,
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
