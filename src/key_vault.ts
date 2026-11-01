// API keys rest in chrome.storage only as {iv, ciphertext} under a non-extractable IndexedDB key.
import { createStore, get, set } from 'idb-keyval';
import { sendCommand, sendCommandResult } from './storage_client';
import { decodeBase64, encodeBase64 } from './utils/base64';

const WRAPPING_KEY_ID = 'wrapping-key-v1';

const vaultStore = createStore('trip-vault', 'keys');

const VAULT_VERSION = 1;

export interface KeyRecord {
  v: number;
  iv: string;
  ciphertext: string;
}

export type KeyStatus = { state: 'ok'; key: string } | { state: 'missing'; orphaned: boolean };

export const vaultStorageKey = (providerId: string): string => `apiKey:${providerId}`;

export const isVaultKey = (key: string): boolean => key.startsWith('apiKey:');

const getOrCreateWrappingKey = async (): Promise<CryptoKey> => {
  const existing = (await get(WRAPPING_KEY_ID, vaultStore)) as CryptoKey | undefined;

  if (existing) {
    return existing;
  }

  const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);

  await set(WRAPPING_KEY_ID, created, vaultStore);

  return created;
};

export const encryptKeyRecord = async (key: string): Promise<KeyRecord> => {
  const wrap = await getOrCreateWrappingKey();

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrap,
    new TextEncoder().encode(key)
  );

  return {
    v: VAULT_VERSION,
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(encrypted)),
  };
};

export const saveKey = async (
  providerId: string,
  key: string,
  sessionOnly: boolean
): Promise<void> => {
  if (!key) {
    throw new Error('cannot save an empty key');
  }

  await sendCommand<void>({ kind: 'key.save', providerId, key, sessionOnly });
};

export const loadKey = async (providerId: string): Promise<KeyStatus> => {
  const name = vaultStorageKey(providerId);

  const fromSession = (await chrome.storage.session.get(name)) as Record<
    string,
    KeyRecord | undefined
  >;

  const fromLocal = (await chrome.storage.local.get(name)) as Record<string, KeyRecord | undefined>;

  const record = fromSession[name] ?? fromLocal[name];

  if (!record || typeof record.ciphertext !== 'string' || typeof record.iv !== 'string') {
    return { state: 'missing', orphaned: false };
  }

  if (typeof record.v === 'number' && record.v !== VAULT_VERSION) {
    return { state: 'missing', orphaned: true };
  }

  const wrap = (await get(WRAPPING_KEY_ID, vaultStore)) as CryptoKey | undefined;

  if (!wrap) {
    return { state: 'missing', orphaned: true };
  }

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decodeBase64(record.iv) },
      wrap,
      decodeBase64(record.ciphertext)
    );

    return { state: 'ok', key: new TextDecoder().decode(decrypted) };
  } catch {
    // Never delete: the ciphertext may belong to a rotated wrapping key or a newer version.
    return { state: 'missing', orphaned: true };
  }
};

export const clearKey = async (providerId: string): Promise<void> => {
  await sendCommand<void>({ kind: 'key.clear', providerId });
};

export interface KeyModeResult {
  sessionOnly: boolean;
  error?: string;
}

// Returns the verified actual mode; transport failures throw.
export const setKeyMode = async (
  providerId: string,
  sessionOnly: boolean
): Promise<KeyModeResult> => {
  const result = await sendCommandResult({ kind: 'key.setMode', providerId, sessionOnly });

  if (result.ok) {
    return { sessionOnly: (result.value as { sessionOnly: boolean }).sessionOnly };
  }

  const actual = (result.value as { sessionOnly?: unknown } | undefined)?.sessionOnly;

  return { sessionOnly: actual === true, error: result.error };
};
