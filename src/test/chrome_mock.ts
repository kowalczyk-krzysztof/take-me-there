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

export type StorageFault = (op: 'get' | 'set' | 'remove' | 'clear', keys: string[]) => void;

export class MockStorageArea {
  readonly data = new Map<string, unknown>();
  fault: StorageFault = () => undefined;
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
      this.fault('get', []);

      return structuredClone(Object.fromEntries(this.data));
    }

    this.fault('get', Array.isArray(keys) ? keys : [keys]);

    const out: Record<string, unknown> = {};

    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.data.has(key)) {
        out[key] = structuredClone(this.data.get(key));
      }
    }

    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.fault('set', Object.keys(items));

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
    this.fault('remove', Array.isArray(keys) ? keys : [keys]);

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
    this.fault('clear', []);
    this.data.clear();
    this.dispatch({});
  }

  private dispatch(changes: Record<string, MockStorageChange>): void {
    // Chrome delivers storage events asynchronously with just the changes
    // on per-area listeners (the area is implicit).
    queueMicrotask(() => {
      // Storage listeners drive the page stores; they run bare so the
      // surrounding harness scope attributes and flushes them. A nested
      // act() scope here would clobber the outer async scope's queue.
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

export interface ScriptingCall {
  target: unknown;
  func: (...args: never[]) => unknown;
  args: unknown[];
}

export interface WorkerFakes {
  installed: Array<(details: { reason: string }) => void>;
  menuClicked: Array<(info: Record<string, unknown>, tab?: Record<string, unknown>) => void>;
  menus: Array<Record<string, unknown>>;
  sidePanelOpens: Array<Record<string, unknown>>;
  panelBehaviors: Array<Record<string, unknown>>;
  tabsCreated: Array<Record<string, unknown>>;
  scriptingCalls: ScriptingCall[];
  scriptingImpl: (call: ScriptingCall) => Promise<Array<{ result: unknown }>>;
}

export type RuntimeMessageHandler = (message: unknown) => Promise<unknown> | unknown;

export type RuntimeMessageListener = (
  message: unknown,
  sender: { id?: string; url?: string },
  sendResponse: (response: unknown) => void
) => unknown;

export interface RuntimeFakes {
  sent: Array<unknown>;
  listeners: Array<RuntimeMessageListener>;
  impl: RuntimeMessageHandler;
}

export interface ChromeMock {
  session: MockStorageArea;
  local: MockStorageArea;
  panelWindow: { id: number };
  worker: WorkerFakes;
  runtime: RuntimeFakes;
}

export const installChromeMock = (): ChromeMock => {
  const session = new MockStorageArea('session');

  const local = new MockStorageArea('local');

  const panelWindow = { id: 1 };

  const runtime: RuntimeFakes = {
    sent: [],
    listeners: [],
    impl: () => {
      throw new Error('sendMessage not routed');
    },
  };

  const worker: WorkerFakes = {
    installed: [],
    menuClicked: [],
    menus: [],
    sidePanelOpens: [],
    panelBehaviors: [],
    tabsCreated: [],
    scriptingCalls: [],
    scriptingImpl: async (call: ScriptingCall) => {
      const name = (call.func as { name?: string })?.name ?? '';

      if (name === 'collectPageImages') {
        return [{ result: [] }];
      }

      return [{ result: null }];
    },
  };
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
    runtime: {
      getURL: (path: string): string => `chrome-extension://test/${path}`,
      id: 'test',
      onInstalled: {
        addListener: (fn: (details: { reason: string }) => void): void => {
          worker.installed.push(fn);
        },
      },
      sendMessage: (message: unknown): Promise<unknown> => {
        runtime.sent.push(message);

        return Promise.resolve().then(() => runtime.impl(message));
      },
      onMessage: {
        addListener: (fn: RuntimeMessageListener): void => {
          runtime.listeners.push(fn);
        },
      },
    },
    contextMenus: {
      create: (props: Record<string, unknown>): unknown => {
        worker.menus.push(props);

        return props['id'];
      },
      removeAll: (callback?: () => void): void => {
        worker.menus.length = 0;
        callback?.();
      },
      onClicked: {
        addListener: (
          fn: (info: Record<string, unknown>, tab?: Record<string, unknown>) => void
        ): void => {
          worker.menuClicked.push(fn);
        },
      },
    },
    sidePanel: {
      open: async (opts: Record<string, unknown>): Promise<void> => {
        worker.sidePanelOpens.push(opts);
      },
      setPanelBehavior: async (opts: Record<string, unknown>): Promise<void> => {
        worker.panelBehaviors.push(opts);
      },
    },
    tabs: {
      create: async (props: Record<string, unknown>): Promise<Record<string, unknown>> => {
        worker.tabsCreated.push(props);

        return { id: 99, ...props };
      },
    },
    scripting: {
      executeScript: async (opts: {
        target: unknown;
        func: (...args: never[]) => unknown;
        args: unknown[];
      }): Promise<Array<{ result: unknown }>> => {
        const call: ScriptingCall = { target: opts.target, func: opts.func, args: opts.args };
        worker.scriptingCalls.push(call);

        return worker.scriptingImpl(call);
      },
    },
  };

  return { session, local, panelWindow, worker, runtime };
};

export const uninstallChromeMock = (): void => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
};
