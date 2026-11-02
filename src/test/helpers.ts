import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { vi } from 'vitest';
import { installChromeMock, type ChromeMock } from './chrome_mock';
import { handleHandoffMessage } from '../handoff';
import { handleStorageMessage } from '../storage_service';

export const waitFor = async (fn: () => unknown, timeoutMs = 5000): Promise<void> => {
  // Short scopes per round, never one long-held scope: exiting flushes renders so the check reads fresh DOM.
  const start = Date.now();

  for (;;) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);

      for (let i = 0; i < 200; i++) {
        await Promise.resolve();
      }
    });

    try {
      await fn();

      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) {
        throw err;
      }
    }
  }
};

// Each event inside act() attributes its updates.
export const clickEl = (target: Element | null): void => {
  act(() => {
    (target as HTMLElement).click();
  });
};

export const focusEl = (target: Element | null): void => {
  act(() => {
    (target as HTMLElement).focus();
  });
};

export const dispatchEl = (target: Element | null, event: Event): boolean => {
  let delivered = false;

  act(() => {
    delivered = (target as Element).dispatchEvent(event);
  });

  return delivered;
};

// The sleep holds an act() scope so straggler updates stay attributed.
export const sleep = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

// Scopes nest lexically and never exit out of order. Await a write through here to attribute its cascade.
export const settleWrite = async <T>(write: Promise<T>): Promise<T> => {
  let result!: T;

  await act(async () => {
    result = await write;

    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
    }
  });

  return result;
};

// Await this after the last event so fire-and-forget chains land attributed.
export const drainStragglers = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
    }
  });
};

export const readShell = (page: string): string =>
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../public', `${page}.html`),
    'utf8'
  );

export const mountShell = (html: string): void => {
  const body = html.split(/<body[^>]*>/)[1]?.split('</body>')[0] ?? '';
  // Strip script tags: the built bundle can neither load nor run here.
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script\s*>/gi, '');
};

interface MountedPage {
  unmountPage?: unknown;
}

let mountedPage: MountedPage | null = null;

export const setupPage = async (
  shell: string,
  fetchMock: ReturnType<typeof vi.fn>,
  runEntry: () => Promise<unknown>,
  beforeImport?: (mock: ChromeMock) => void | Promise<void>
): Promise<ChromeMock> => {
  // Freeze wall-clock timers (setImmediate and microtasks stay real); time advances only inside waitFor/sleep scopes.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  // Stub digests onto microtasks: fake time would otherwise outrun the real threadpool.
  const realDigest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    if (algorithm !== 'SHA-256') {
      return realDigest(algorithm, data);
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const hash = createHash('sha256').update(bytes).digest();
    const out = new ArrayBuffer(hash.byteLength);
    new Uint8Array(out).set(hash);
    return out;
  });
  vi.resetModules();

  const mock = installChromeMock();
  routeWorkerMessages(mock);

  fetchMock.mockReset();
  if (beforeImport) {
    await beforeImport(mock);
  }
  mountShell(shell);
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    mountedPage = (await runEntry()) as MountedPage | null;
    // Settle initPanel's fire-and-forget chains first. Microtask rounds only: nothing is due this early.
    for (let i = 0; i < 100; i++) {
      await Promise.resolve();
    }
  });

  return mock;
};

// Route worker messages to the real handlers: the same validated, serialized path production uses.
export const routeWorkerMessages = (mock: ChromeMock): void => {
  const sender = { id: 'test', url: 'chrome-extension://test/sidepanel.html' };

  mock.runtime.impl = async (message: unknown) => {
    const stored = await handleStorageMessage(message, sender);

    if (stored !== undefined) {
      return stored;
    }

    const acked = await handleHandoffMessage(message, sender);

    if (acked !== undefined) {
      return acked;
    }

    throw new Error('message not routed');
  };
};

export const teardownPage = (): void => {
  // Unmount before clearing the DOM; mocks stay installed until the next setup so in-flight tails keep running.
  act(() => {
    if (typeof mountedPage?.unmountPage === 'function') {
      (mountedPage.unmountPage as () => void)();
    }
    mountedPage = null;
  });
  // Thaw timers: pending fake callbacks die quietly instead of firing into the next test.
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
};

export const chatResponse = (
  place: unknown,
  usage = { prompt_tokens: 100, completion_tokens: 50 }
): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(place) } }], usage }),
    {
      status: 200,
    }
  );

export const groundedResponse = (json: unknown): Response =>
  new Response(
    JSON.stringify({
      output: [
        { type: 'web_search_call', status: 'completed' },
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(json) }],
        },
      ],
      usage: { input_tokens: 200, output_tokens: 80 },
    }),
    { status: 200 }
  );

export const plantKeyAndConsent = async (): Promise<void> => {
  await act(async () => {
    const { persistKey } = await import('../key_vault');

    const { setConsented } = await import('../providers/index');
    await persistKey('muse', 'LLM_x', false);
    await setConsented();

    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
    }
  });
};
