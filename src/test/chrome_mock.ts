// Hand-rolled chrome mock for unit tests: Map-backed storage areas with
// onChanged dispatch, a catalog-checked i18n, and minimal runtime stubs. No
// mocking library.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const catalog = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../public/_locales/en/messages.json'),
    'utf8'
  )
) as Record<string, { message: string }>;

export const catalogKeys = (): Set<string> => new Set(Object.keys(catalog));

// Identity-preserving but strict: known keys echo so behavior tests pin the
// message identity (stable across copy edits), substitutions stay visible so
// wrong amounts/counts fail, and unknown keys surface as '' like Chrome.
const getMessage = (key: string, subs?: string | string[]): string => {
  if (!Object.hasOwn(catalog, key)) {
    return '';
  }
  const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
  return list.length === 0 ? key : `${key}(${list.join(' | ')})`;
};
export interface MockStorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export type MockChangeListener = (changes: Record<string, MockStorageChange>) => void;

export type MockGlobalChangeListener = (
  changes: Record<string, MockStorageChange>,
  areaName: string
) => void;

export class MockStorageArea {
  readonly data = new Map<string, unknown>();
  private listeners = new Set<MockChangeListener>();
  readonly onChanged = {
    addListener: (fn: MockChangeListener): void => {
      this.listeners.add(fn);
    },
    removeListener: (fn: MockChangeListener): void => {
      this.listeners.delete(fn);
    },
  };

  private readonly areaName: string;

  constructor(areaName: string) {
    this.areaName = areaName;
  }

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys === null || keys === undefined) {
      return structuredClone(Object.fromEntries(this.data));
    }
    const out: Record<string, unknown> = {};
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.data.has(key)) {
        out[key] = structuredClone(this.data.get(key));
      }
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, MockStorageChange> = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = {
        oldValue: structuredClone(this.data.get(key)),
        newValue: structuredClone(value),
      };
      this.data.set(key, structuredClone(value));
    }
    this.dispatch(changes);
  }

  async remove(keys: string | string[]): Promise<void> {
    const changes: Record<string, MockStorageChange> = {};
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.data.has(key)) {
        changes[key] = { oldValue: structuredClone(this.data.get(key)), newValue: undefined };
        this.data.delete(key);
      }
    }
    this.dispatch(changes);
  }

  async clear(): Promise<void> {
    this.data.clear();
    this.dispatch({});
  }

  private dispatch(changes: Record<string, MockStorageChange>): void {
    // Chrome delivers storage events asynchronously with just the changes
    // on per-area listeners (the area is implicit).
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener(structuredClone(changes));
      }
      for (const listener of this.globalListeners) {
        listener(structuredClone(changes), this.areaName);
      }
    });
  }

  private readonly globalListeners = new Set<MockGlobalChangeListener>();

  addGlobalListener(fn: MockGlobalChangeListener): void {
    this.globalListeners.add(fn);
  }

  removeGlobalListener(fn: MockGlobalChangeListener): void {
    this.globalListeners.delete(fn);
  }
}

export interface ChromeMock {
  session: MockStorageArea;
  local: MockStorageArea;
  panelWindow: { id: number };
}

export const installChromeMock = (): ChromeMock => {
  const session = new MockStorageArea('session');
  const local = new MockStorageArea('local');
  const panelWindow = { id: 1 };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session,
      local,
      onChanged: {
        addListener: (fn: MockGlobalChangeListener): void => {
          session.addGlobalListener(fn);
          local.addGlobalListener(fn);
        },
        removeListener: (fn: MockGlobalChangeListener): void => {
          session.removeGlobalListener(fn);
          local.removeGlobalListener(fn);
        },
      },
    },
    i18n: {
      getMessage,
      getUILanguage: (): string => 'en-US',
    },
    commands: { getAll: async (): Promise<Array<{ name?: string }>> => [] },
    windows: { getCurrent: async (): Promise<{ id: number }> => ({ id: panelWindow.id }) },
    runtime: { getURL: (path: string): string => `chrome-extension://test/${path}`, id: 'test' },
  };
  return { session, local, panelWindow };
};

export const uninstallChromeMock = (): void => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
};
