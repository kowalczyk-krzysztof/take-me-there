import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('idb-keyval', () => {
  const stores = new Map<string, Map<unknown, unknown>>();

  const area = (id: string): Map<unknown, unknown> => {
    let found = stores.get(id);

    if (!found) {
      found = new Map();
      stores.set(id, found);
    }

    return found;
  };

  return {
    createStore: (db: string, name: string): string => `${db}:${name}`,
    get: async (key: unknown, store: string): Promise<unknown> => area(store).get(key),
    set: async (key: unknown, value: unknown, store: string): Promise<void> => {
      area(store).set(key, value);
    },
    del: async (key: unknown, store: string): Promise<void> => {
      area(store).delete(key);
    },
    __reset: (): void => {
      stores.clear();
    },
  };
});

import * as idbKeyval from 'idb-keyval';
import { clearKey, loadKey, persistKey, type KeyRecord } from './key_vault';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';
import { routeWorkerMessages } from './test/helpers';

const resetIdb = (): void => {
  (idbKeyval as unknown as { __reset: () => void }).__reset();
};

let mock: ChromeMock;

beforeEach(() => {
  resetIdb();
  mock = installChromeMock();
  routeWorkerMessages(mock);
});

afterEach(() => {
  uninstallChromeMock();
});

describe('key_vault', () => {
  it('round-trips a key through encrypted local storage', async () => {
    await persistKey('muse', 'LLM_secret-value', false);
    expect(await loadKey('muse')).toEqual({ state: 'ok', key: 'LLM_secret-value' });

    const record = mock.local.data.get('apiKey:muse') as KeyRecord;
    expect(typeof record.iv).toBe('string');
    expect(typeof record.ciphertext).toBe('string');
    expect(JSON.stringify(mock.local.data.get('apiKey:muse'))).not.toContain('LLM_');
    expect(mock.session.data.has('apiKey:muse')).toBe(false);
  });

  it('reports a missing key without the orphan flag', async () => {
    expect(await loadKey('muse')).toEqual({ state: 'missing', orphaned: false });
  });

  it('routes session-only keys to session storage and clears local', async () => {
    await persistKey('muse', 'LLM_first', false);
    expect(mock.local.data.has('apiKey:muse')).toBe(true);
    await persistKey('muse', 'LLM_second', true);
    expect(mock.session.data.has('apiKey:muse')).toBe(true);
    expect(mock.local.data.has('apiKey:muse')).toBe(false);
    expect(await loadKey('muse')).toEqual({ state: 'ok', key: 'LLM_second' });
  });

  it('treats a lost wrapping key as an orphan and keeps the ciphertext', async () => {
    await persistKey('muse', 'LLM_secret-value', false);
    resetIdb();
    expect(await loadKey('muse')).toEqual({ state: 'missing', orphaned: true });
    expect(mock.local.data.has('apiKey:muse')).toBe(true);
  });

  it('treats tampered ciphertext as an orphan and keeps it', async () => {
    await persistKey('muse', 'LLM_secret-value', false);

    const record = { ...(mock.local.data.get('apiKey:muse') as KeyRecord) };
    record.ciphertext = `${record.ciphertext.slice(0, -1)}A`;
    mock.local.data.set('apiKey:muse', record);
    expect(await loadKey('muse')).toEqual({ state: 'missing', orphaned: true });
    expect(mock.local.data.has('apiKey:muse')).toBe(true);
  });

  it('reads legacy records without a version', async () => {
    await persistKey('muse', 'LLM_secret-value', false);

    const record = { ...(mock.local.data.get('apiKey:muse') as KeyRecord) } as Record<
      string,
      unknown
    >;
    delete record.v;
    mock.local.data.set('apiKey:muse', record);
    expect(await loadKey('muse')).toEqual({ state: 'ok', key: 'LLM_secret-value' });
  });

  it('orphans records from a newer version instead of deleting them', async () => {
    await persistKey('muse', 'LLM_secret-value', false);

    const record = { ...(mock.local.data.get('apiKey:muse') as KeyRecord), v: 99 };
    mock.local.data.set('apiKey:muse', record);
    expect(await loadKey('muse')).toEqual({ state: 'missing', orphaned: true });
    expect(mock.local.data.get('apiKey:muse')).toEqual(record);
  });

  it('clears keys from both areas', async () => {
    await persistKey('muse', 'LLM_secret-value', false);
    await persistKey('openai_compat', 'sk-other', true);
    await clearKey('muse');
    expect(await loadKey('muse')).toEqual({ state: 'missing', orphaned: false });
    expect(await loadKey('openai_compat')).toEqual({ state: 'ok', key: 'sk-other' });
  });
});
