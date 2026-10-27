// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  };
});

import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

const SHELL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../public/sidepanel.html'),
  'utf8',
);

const mountShell = (): void => {
  const body = SHELL.split(/<body[^>]*>/)[1]?.split('</body>')[0] ?? '';
  document.body.innerHTML = body;
};

const waitFor = async (fn: () => void, timeoutMs = 5000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    try {
      fn();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
};

const VALID_PLACE = {
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.9,
  oneLiner: 'Blue domes over the caldera.',
};

const SIGNALS = {
  imgFound: true,
  alt: 'Blue domes',
  imgTitle: '',
  figcaption: '',
  nearestHeading: '',
  nearestParagraph: '',
  ogTitle: '',
  ogDescription: '',
  ogSiteName: '',
  docTitle: 'Guide',
  metaDescription: '',
  canonical: 'https://example.com/guide',
  pageHost: 'example.com',
  urlSlug: 'guide',
  imgFileSlug: 'oia',
  jsonLd: [],
};

const READY = (overrides: Record<string, unknown> = {}) => ({
  requestId: '100-1',
  status: 'ready',
  srcUrl: 'https://cdn.example.com/oia.jpg',
  dataPending: false,
  pageUrl: 'https://example.com/guide',
  tabId: 7,
  signals: SIGNALS,
  ...overrides,
});

const chatResponse = (place: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(place) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    { status: 200 },
  );

const sseResponse = (chunks: string[]) => {
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

const GUIDE_SSE = [
  'event: response.web_search_call.searching\n',
  'data: {}\n',
  '\n',
  'event: response.output_text.delta\n',
  'data: {"delta":"Hello "}\n',
  '\n',
  'event: response.output_text.delta\n',
  'data: {"delta":"world"}\n',
  '\n',
  'event: response.output_text.annotation.added\n',
  'data: {"annotation":{"type":"url_citation","url":"https://example.com/a","title":"A"}}\n',
  '\n',
  'event: response.web_search_call.completed\n',
  'data: {}\n',
  '\n',
  'event: response.completed\n',
  'data: {"response":{"usage":{"input_tokens":300,"output_tokens":120}}}\n',
  '\n',
].join('');

const fetchMock = vi.fn();

const setup = async (): Promise<ChromeMock> => {
  vi.resetModules();
  const mock = installChromeMock();
  mountShell();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  await import('./sidepanel');
  return mock;
};

const plantKeyAndConsent = async (): Promise<void> => {
  const { saveKey } = await import('./key_vault');
  const { setConsented } = await import('./providers/index');
  await saveKey('muse', 'LLM_x', false);
  await setConsented();
};

afterEach(() => {
  document.body.innerHTML = '';
  uninstallChromeMock();
  vi.unstubAllGlobals();
});

describe('sidepanel', () => {
  it('renders idle with the manual form', async () => {
    await setup();
    const card = document.querySelector('trip-card');
    expect(card?.shadowRoot?.querySelector('.hint')?.textContent).toBe('panelIdle');
    expect(document.querySelector('#manual-label')?.textContent).toBe('manualLabel');
    expect(document.querySelector('#manual-go')?.textContent).toBe('manualGoButton');
    await waitFor(() => {
      expect(card?.shadowRoot?.querySelector('.shortcut')?.textContent).toBe('shortcutUnset');
    });
  });

  it('shows inline key setup when no key is saved', async () => {
    const mock = await setup();
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      expect(document.querySelector('key-setup')).not.toBeNull();
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('statusKeyNeeded');
    const img = document.querySelector('#preview-frame img') as HTMLImageElement | null;
    expect(img?.src).toContain('oia.jpg');
  });

  it('runs identify plus a grounded guide end to end', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    await waitFor(() => {
      expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    });
    const grid = document.querySelector('booking-grid');
    expect(grid?.shadowRoot?.querySelectorAll('a.tile')).toHaveLength(4);
    const chips = document.querySelector('source-chips');
    expect(chips?.shadowRoot?.querySelectorAll('a.chip')).toHaveLength(1);
    expect(document.querySelector('#cost-line')?.textContent).toBe('costLine');
    expect(document.querySelector('#status-region')?.textContent).toBe('statusGuideReadySources');
  });

  it('serves repeat images from cache without fetching', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { hashCacheKey, setCacheEntry } = await import('./sidepanel');
    const hash = await hashCacheKey('https://cdn.example.com/oia.jpg', 'https://example.com/guide');
    await setCacheEntry(hash, {
      place: VALID_PLACE,
      guide: 'Cached guide text.',
      sources: [],
      usage: { inputTokens: 0, outputTokens: 0, searchCount: 0, flatFeesUsd: 0 },
      searchedWeb: false,
    });
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      expect(document.querySelector('#cost-line')?.textContent).toBe('costLineCache');
    });
    expect(document.querySelector('#guide-content')?.textContent).toContain('Cached guide text.');
    expect(document.querySelector('#status-region')?.textContent).toBe('statusCacheHit');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recovers from a rejected key through the inline fix', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('errorAuthTitle');
    });
    expect(document.querySelector('key-setup')).not.toBeNull();
    fetchMock
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    const keySetup = document.querySelector('key-setup') as HTMLElement;
    keySetup.dispatchEvent(
      new CustomEvent('key-save-request', {
        detail: { key: 'LLM_good', sessionOnly: false },
        bubbles: true,
        composed: true,
      }),
    );
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
  });

  it('plans manual destinations with links plus a streamed guide', async () => {
    await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    (document.querySelector('#manual-input') as HTMLInputElement).value = 'Oia, Greece';
    (document.querySelector('#manual-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await waitFor(() => {
      const grid = document.querySelector('booking-grid');
      expect(grid?.shadowRoot?.querySelectorAll('a.tile')).toHaveLength(4);
    });
    await waitFor(() => {
      expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    });
  });
});
