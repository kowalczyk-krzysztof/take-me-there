// Encrypted API-key storage. A non-extractable AES-GCM key lives in the
// extension origin's IndexedDB (via idb-keyval); API keys rest in
// chrome.storage only as {iv, ciphertext}. Session-only mode keeps the
// ciphertext in storage.session (memory-only, wiped on exit) instead.
import { createStore, get, set } from 'idb-keyval';

const WRAPPING_KEY_ID = 'wrapping-key-v1';

const vaultStore = createStore('trip-vault', 'keys');

export interface KeyRecord {
  iv: string;
  ciphertext: string;
}

export type KeyStatus = { state: 'ok'; key: string } | { state: 'missing'; orphaned: boolean };

const storageKey = (providerId: string): string => `apiKey:${providerId}`;

export const isVaultKey = (key: string): boolean => key.startsWith('apiKey:');

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

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

export const saveKey = async (
  providerId: string,
  key: string,
  sessionOnly: boolean,
): Promise<void> => {
  if (!key) {
    throw new Error('cannot save an empty key');
  }
  const wrap = await getOrCreateWrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrap,
    new TextEncoder().encode(key),
  );
  const record: KeyRecord = { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) };
  const name = storageKey(providerId);
  if (sessionOnly) {
    await chrome.storage.session.set({ [name]: record });
    await chrome.storage.local.remove(name);
  } else {
    await chrome.storage.local.set({ [name]: record });
    await chrome.storage.session.remove(name);
  }
};

export const loadKey = async (providerId: string): Promise<KeyStatus> => {
  const name = storageKey(providerId);
  const fromSession = (await chrome.storage.session.get(name)) as Record<
    string,
    KeyRecord | undefined
  >;
  const fromLocal = (await chrome.storage.local.get(name)) as Record<string, KeyRecord | undefined>;
  const record = fromSession[name] ?? fromLocal[name];
  if (!record || typeof record.ciphertext !== 'string' || typeof record.iv !== 'string') {
    return { state: 'missing', orphaned: false };
  }
  const wrap = (await get(WRAPPING_KEY_ID, vaultStore)) as CryptoKey | undefined;
  if (!wrap) {
    await clearKey(providerId);
    return { state: 'missing', orphaned: true };
  }
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(record.iv) },
      wrap,
      fromBase64(record.ciphertext),
    );
    return { state: 'ok', key: new TextDecoder().decode(decrypted) };
  } catch {
    await clearKey(providerId);
    return { state: 'missing', orphaned: true };
  }
};

export const clearKey = async (providerId: string): Promise<void> => {
  const name = storageKey(providerId);
  await chrome.storage.session.remove(name);
  await chrome.storage.local.remove(name);
};
