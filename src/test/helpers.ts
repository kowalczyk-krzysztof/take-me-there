import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './chrome_mock';

export const waitFor = async (fn: () => unknown, timeoutMs = 5000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    try {
      await fn();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
};

export const readShell = (page: string): string =>
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../public', `${page}.html`),
    'utf8'
  );

export const mountShell = (html: string): void => {
  const body = html.split(/<body[^>]*>/)[1]?.split('</body>')[0] ?? '';
  document.body.innerHTML = body;
};

export const setupPage = async (
  shell: string,
  fetchMock: ReturnType<typeof vi.fn>,
  runEntry: () => Promise<unknown>,
  beforeImport?: (mock: ChromeMock) => void | Promise<void>
): Promise<ChromeMock> => {
  vi.resetModules();
  const mock = installChromeMock();
  if (beforeImport) {
    await beforeImport(mock);
  }
  mountShell(shell);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  await runEntry();
  return mock;
};

export const teardownPage = (): void => {
  document.body.innerHTML = '';
  uninstallChromeMock();
  vi.unstubAllGlobals();
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
  const { saveKey } = await import('../key_vault');
  const { setConsented } = await import('../providers/index');
  await saveKey('muse', 'LLM_x', false);
  await setConsented();
};
