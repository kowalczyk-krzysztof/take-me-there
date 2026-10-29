import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { vi } from 'vitest';
import { installChromeMock, type ChromeMock } from './chrome_mock';
import { handleHandoffMessage } from '../handoff';
import { handleStorageMessage } from '../storage_service';

export const waitFor = async (fn: () => unknown, timeoutMs = 5000): Promise<void> => {
  await act(async () => {
    const start = Date.now();

    for (;;) {
      try {
        await fn();

        // Settle the convergence cascade before returning so the test
        // resumes (and later ends) with no unattributed updates queued.
        for (let i = 0; i < 100; i++) {
          await Promise.resolve();
        }

        return;
      } catch (err) {
        if (Date.now() - start > timeoutMs) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
};

// DOM events drive React through store updates; delivering each event
// inside act() attributes those updates the way React Testing Library's
// fireEvent does.
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

// Negative tests sleep to prove nothing happens; the sleep holds an act()
// scope so straggler updates stay attributed instead of warning.
export const sleep = async (ms: number): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

// Async act() scopes live only in test call-stack code: the mock opens
// sync scopes alone, so scopes always nest lexically and can never exit
// out of order. Await a storage or vault write through here to attribute
// its listener cascade; pure microtasks, safe under fake timers.
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

// Attribution window for cascade-free awaits (reads, imports, hashes):
// product timers can fire while they yield, and those updates need an
// open scope as much as write cascades do.
export const cover = async <T>(work: Promise<T>): Promise<T> => {
  let result!: T;

  await act(async () => {
    result = await work;
  });

  return result;
};

export const readShell = (page: string): string =>
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../public', `${page}.html`),
    'utf8'
  );

export const mountShell = (html: string): void => {
  const body = html.split(/<body[^>]*>/)[1]?.split('</body>')[0] ?? '';
  // The shell references the built bundle, which can neither load nor run
  // here: the entry module is imported directly. Strip script tags so the
  // mounted test DOM contains only what the test drives.
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
    // initPanel kicks fire-and-forget chains (lock, board, settings,
    // handoff watch): settle them before returning so no test await
    // observes their unattributed updates.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return mock;
};

// Routes worker-bound messages to the real worker handlers: every store
// test below exercises the same validated, serialized path production uses,
// and handoff acks genuinely clear the mocked window slots.
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
  // Unmount before clearing the DOM: a live root would otherwise render
  // into the torn-down page when a trailing act() flush lands after the
  // test. The chrome and fetch mocks stay installed until the next setup
  // reinstalls them: in-flight tails keep running past the last assertion
  // and must never observe the globals disappear mid-chain.
  act(() => {
    if (typeof mountedPage?.unmountPage === 'function') {
      (mountedPage.unmountPage as () => void)();
    }
    mountedPage = null;
  });
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

export const sseResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
};

export const groundedResponse = (json: unknown, annotations: unknown[] = []): Response =>
  new Response(
    JSON.stringify({
      output: [
        { type: 'web_search_call' },
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(json), annotations }],
        },
      ],
      usage: { input_tokens: 200, output_tokens: 80 },
    }),
    { status: 200 }
  );

export const plantKeyAndConsent = async (): Promise<void> => {
  await act(async () => {
    const { saveKey } = await import('../key_vault');

    const { setConsented } = await import('../providers/index');
    await saveKey('muse', 'LLM_x', false);
    await setConsented();
  });
};
