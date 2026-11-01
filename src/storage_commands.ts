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

const settingsPatchSchema = z.strictObject({
  imageOnly: z.optional(z.boolean()),
  skipWebSearch: z.optional(z.boolean()),
  cacheTtlDays: z.optional(z.number()),
});

const providerSchema = z.strictObject({
  providerId: z.string().check(z.maxLength(64)),
});

const keyPersistSchema = z.strictObject({
  providerId: z.string().check(z.maxLength(64)),
  key: z.string().check(z.maxLength(4000)),
  sessionOnly: z.boolean(),
});

const keyModeSchema = z.strictObject({
  providerId: z.string().check(z.maxLength(64)),
  sessionOnly: z.boolean(),
});

const grantOriginSchema = z.strictObject({
  origin: z.string().check(z.maxLength(256)),
});

const emptySchema = z.strictObject({});

export type StorageCommand =
  | { kind: 'spend.record'; amountUsd: number; at: number }
  | { kind: 'cache.get'; hash: string }
  | { kind: 'cache.set'; hash: string; entry: z.infer<typeof cacheEntrySchema> }
  | { kind: 'cache.clear' }
  | { kind: 'settings.patch'; patch: z.infer<typeof settingsPatchSchema> }
  | { kind: 'key.persist'; providerId: string; key: string; sessionOnly: boolean }
  | { kind: 'key.clear'; providerId: string }
  | { kind: 'key.setMode'; providerId: string; sessionOnly: boolean }
  | { kind: 'grant.add'; origin: string }
  | { kind: 'grant.release'; origin: string }
  | { kind: 'grant.cancel'; origin: string }
  | { kind: 'grant.reconcile' }
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
  'settings.patch': z.strictObject({ patch: settingsPatchSchema }),
  'key.persist': keyPersistSchema,
  'key.clear': providerSchema,
  'key.setMode': keyModeSchema,
  'grant.add': grantOriginSchema,
  'grant.release': grantOriginSchema,
  'grant.cancel': grantOriginSchema,
  'grant.reconcile': emptySchema,
  'migrate.run': emptySchema,
};

export const commandPayload = (command: StorageCommand): unknown => {
  const { kind: _kind, ...payload } = command;

  return payload;
};
