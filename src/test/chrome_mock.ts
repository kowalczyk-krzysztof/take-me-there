// Hand-rolled chrome mock for unit tests: Map-backed storage areas with
// onChanged dispatch, an echoing i18n, and minimal runtime stubs. No mocking
// library.
export interface MockStorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export type MockChangeListener = (
  changes: Record<string, MockStorageChange>,
  areaName: string,
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

  constructor(private readonly areaName: string) {}

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys === null || keys === undefined) {
      return Object.fromEntries(this.data);
    }
    const out: Record<string, unknown> = {};
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.data.has(key)) {
        out[key] = this.data.get(key);
      }
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, MockStorageChange> = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: this.data.get(key), newValue: value };
      this.data.set(key, value);
    }
    this.dispatch(changes);
  }

  async remove(keys: string | string[]): Promise<void> {
    const changes: Record<string, MockStorageChange> = {};
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.data.has(key)) {
        changes[key] = { oldValue: this.data.get(key), newValue: undefined };
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
    for (const listener of this.listeners) {
      listener(changes, this.areaName);
    }
  }
}

export interface ChromeMock {
  session: MockStorageArea;
  local: MockStorageArea;
}

export const installChromeMock = (): ChromeMock => {
  const session = new MockStorageArea('session');
  const local = new MockStorageArea('local');
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session,
      local,
      onChanged: { addListener: (): void => {}, removeListener: (): void => {} },
    },
    i18n: {
      getMessage: (key: string): string => key,
      getUILanguage: (): string => 'en-US',
    },
    commands: { getAll: async (): Promise<Array<{ name?: string }>> => [] },
    runtime: { getURL: (path: string): string => `chrome-extension://test/${path}`, id: 'test' },
  };
  return { session, local };
};

export const uninstallChromeMock = (): void => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
};
