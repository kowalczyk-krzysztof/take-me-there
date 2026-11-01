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
  // Sequential short scopes, never one long-held scope: each round opens
  // a scope, advances fake time, drains the microtask cascade its timers
  // and listeners schedule, then exits, and exiting flushes renders and
  // effects so the convergence check below reads fresh DOM. Holding one
  // scope across the whole poll would queue updates without flushing
  // (converging only via a nested scope, whose exit clobbers the outer
  // queue and unattributedly warns afterwards).
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
    await vi.advanceTimersByTimeAsync(ms);
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

// End-of-test drain for sync-tailed tests: DOM events kick
// fire-and-forget product chains, and a test whose last lines are pure
// sync events and asserts has no later scope for those aftershocks to
// land in, so they would complete in the post-return gap unattributed.
// Await this after the last event instead.
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
  // Freeze wall-clock timers (skeleton, settle, stale, SAM dwell):
  // setImmediate stays real so act() flushes never stall, microtasks
  // stay real so cascades interleave, and time advances only inside
  // waitFor/sleep scopes where product timer callbacks are attributed.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  // WebCrypto digests run on a real threadpool, which fake time would
  // otherwise outrun (inverting completion order against timer-paced
  // flows). Same SHA-256, resolved in microtasks instead.
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
    // initPanel kicks fire-and-forget chains (key state, settings,
    // handoff watch): settle them before returning so no test await
    // observes their unattributed updates. Microtask rounds (no timer
    // advancement): nothing is due this early, and advancing zero would
    // not yield.
    for (let i = 0; i < 100; i++) {
      await Promise.resolve();
    }
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
  // Thaw timers: pending fake callbacks are discarded with the clock,
  // so in-flight tails die quietly instead of firing into the next test.
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
        { type: 'web_search_call' },
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
    const { saveKey } = await import('../key_vault');

    const { setConsented } = await import('../providers/index');
    await saveKey('muse', 'LLM_x', false);
    await setConsented();

    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
    }
  });
};
