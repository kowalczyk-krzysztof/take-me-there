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

const waitFor = async (fn: () => unknown, timeoutMs = 5000): Promise<void> => {
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

const groundedResponse = (json: unknown, annotations: unknown[] = []) =>
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
    { status: 200 },
  );

const nanoSession = (promptText: string, chunks: string[]) => {
  const session = {
    prompt: vi.fn().mockResolvedValue(promptText),
    promptStreaming: vi.fn().mockImplementation(async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    }),
    clone: vi.fn(),
    destroy: vi.fn(),
  };
  session.clone.mockResolvedValue(session);
  return session;
};

const installNano = (states: string[], session: ReturnType<typeof nanoSession>) => {
  const availability = vi.fn();
  for (let i = 0; i < states.length - 1; i++) {
    availability.mockResolvedValueOnce(states[i]);
  }
  availability.mockResolvedValue(states[states.length - 1]);
  const create = vi.fn().mockResolvedValue(session);
  vi.stubGlobal('LanguageModel', { availability, create });
  return { availability, create, session };
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

afterEach(async () => {
  document.body.innerHTML = '';
  uninstallChromeMock();
  vi.unstubAllGlobals();
  // Dynamic import: the module graph is warm by teardown, so this cannot
  // re-enter the provider registry cycle.
  const { resetNanoSession } = await import('./providers/chrome_nano');
  resetNanoSession();
});

describe('sidepanel', () => {
  it('renders the idle hint', async () => {
    await setup();
    const card = document.querySelector('trip-card');
    expect(card?.shadowRoot?.querySelector('.hint')?.textContent).toBe('panelIdle');
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

  it('gates low-confidence guesses behind the no-place card', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const GUESS = { ...VALID_PLACE, confidence: 0.2 };
    fetchMock
      .mockResolvedValueOnce(chatResponse(GUESS))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('noPlaceTitle');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.primary') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(card.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: Array<{ text?: string }> | string }>;
      reasoning_effort: string;
    };
    const parts = body.messages[1].content as Array<{ text?: string }>;
    expect(parts[0].text).toContain('NOT Oia');
    expect(body.reasoning_effort).toBe('medium');
  });

  it('holds back guide preamble and renders from the heading', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(
        sseResponse([
          'event: response.output_text.delta\n',
          'data: {"delta":"I will research Oia to build your factual trip guide."}\n',
          '\n',
          'event: response.output_text.delta\n',
          'data: {"delta":"## Oia\\nHello world"}\n',
          '\n',
          'event: response.completed\n',
          'data: {"response":{"usage":{"input_tokens":100,"output_tokens":50}}}\n',
          '\n',
        ]),
      );
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusGuideReady');
    });
    const content = document.querySelector('#guide-content');
    expect(content?.textContent).toContain('Hello world');
    expect(content?.textContent).not.toContain('research Oia');
    expect(content?.querySelector('h3')?.textContent).toBe('Oia');
  });

  it('gates the first video analysis behind the frame confirm', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await mock.session.set({
      tripRequest: READY({
        srcUrl: 'blob:https://example.com/aaa',
        mediaType: 'video',
        frame: { dataUrl: 'data:image/jpeg,frame', time: 12.5 },
      }),
    });
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('videoConfirmTitle');
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('statusVideoConfirmNeeded');
    expect(fetchMock).not.toHaveBeenCalled();
    const buttons = [...document.querySelectorAll('.confirm-actions button')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'videoConfirmAgree',
      'videoConfirmCancel',
    ]);
    const img = document.querySelector('#preview-frame img') as HTMLImageElement | null;
    expect(img?.getAttribute('src')).toBe('data:image/jpeg,frame');
    expect(img?.alt).toBe('previewAltFrame');
  });

  it('analyzes the captured frame after the video confirm', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({
      tripRequest: READY({
        srcUrl: 'blob:https://example.com/aaa',
        mediaType: 'video',
        frame: { dataUrl: 'data:image/jpeg,frame', time: 12.5 },
      }),
    });
    await waitFor(() => {
      expect(document.querySelector('.confirm-actions .primary')).not.toBeNull();
    });
    (document.querySelector('.confirm-actions .primary') as HTMLButtonElement).click();
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: Array<{ image_url?: { url: string } }> }>;
    };
    expect(body.messages[1].content[1].image_url?.url).toBe('data:image/jpeg,frame');
    expect(document.querySelector('#privacy-line')?.textContent).toBe('privacyVideoFrame');
    // The gate is one-time: the next video analyzes without asking.
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({
      tripRequest: READY({
        requestId: '200-2',
        srcUrl: 'blob:https://example.com/bbb',
        mediaType: 'video',
        frame: { dataUrl: 'data:image/jpeg,frame2', time: 3 },
      }),
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(document.querySelector('.confirm-actions')).toBeNull();
  });

  it('discards the staged video when the confirm is declined', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await mock.session.set({
      tripRequest: READY({
        srcUrl: 'blob:https://example.com/aaa',
        mediaType: 'video',
        frame: { dataUrl: 'data:image/jpeg,frame', time: 12.5 },
      }),
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.confirm-actions button')).toHaveLength(2);
    });
    const cancel = [...document.querySelectorAll('.confirm-actions button')][1] as HTMLButtonElement;
    cancel.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe(
        'statusVideoConfirmDeclined',
      );
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs rung 2 for tainted mp4 video with the video part', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { setVideoConsented } = await import('./video');
    await setVideoConsented();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({
      tripRequest: READY({
        srcUrl: 'https://cdn.example.com/trip.mp4',
        mediaType: 'video',
        frameError: 'tainted',
      }),
    });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    expect(body.messages[1].content[1].type).toBe('video_url');
    expect(document.querySelector('#privacy-line')?.textContent).toBe('privacyVideoUrl');
  });

  it('pins results to the board with announcements', async () => {
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
    const card = document.querySelector('trip-card') as HTMLElement;
    const pin = card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    pin.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned');
    });
    expect(
      (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    const board = document.querySelector('trip-board') as HTMLElement;
    const items = [...(board.shadowRoot?.querySelectorAll('li') ?? [])];
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('.item-name')?.textContent).toBe('Oia, Greece');
    expect(items[0].querySelector('.item-host')?.textContent).toBe('example.com');
    expect(
      (board.shadowRoot?.querySelector('.plan-button') as HTMLButtonElement).getAttribute(
        'aria-disabled',
      ),
    ).toBe('true');
    (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinDuplicate');
    });
    expect(board.shadowRoot?.querySelectorAll('li')).toHaveLength(1);
    const remove = items[0].querySelector('button') as HTMLButtonElement;
    remove.click();
    await waitFor(() => {
      expect(board.shadowRoot?.querySelectorAll('li')).toHaveLength(0);
    });
    expect(
      (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).getAttribute(
        'aria-pressed',
      ),
    ).toBe('false');
  });

  it('retries failed pins without the thumbnail', async () => {
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
    const fail = vi.spyOn(mock.local, 'set').mockRejectedValueOnce(new Error('quota'));
    const card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('alertPinFail');
    });
    const board = document.querySelector('trip-board') as HTMLElement;
    expect(board.shadowRoot?.querySelector('.notice')?.textContent).toContain('boardNoticePinFail');
    fail.mockRestore();
    (board.shadowRoot?.querySelector('.notice button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned');
    });
    const { listPins } = await import('./board_store');
    const pins = await listPins();
    expect(pins).toHaveLength(1);
    expect(pins[0].thumbnail).toBeUndefined();
  });

  it('clears the board through the inline confirm', async () => {
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
    const card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned');
    });
    const board = document.querySelector('trip-board') as HTMLElement;
    (board.shadowRoot?.querySelector('.clear-button') as HTMLButtonElement).click();
    expect(board.shadowRoot?.querySelector('.confirm-heading')?.textContent).toBe(
      'boardClearTitle',
    );
    const [, cancel] = [
      ...(board.shadowRoot?.querySelectorAll('.confirm-actions button') ?? []),
    ] as HTMLButtonElement[];
    cancel.click();
    expect(board.shadowRoot?.querySelectorAll('li')).toHaveLength(1);
    (board.shadowRoot?.querySelector('.clear-button') as HTMLButtonElement).click();
    const [confirm] = [
      ...(board.shadowRoot?.querySelectorAll('.confirm-actions button') ?? []),
    ] as HTMLButtonElement[];
    confirm.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('boardCleared');
    });
    expect(board.shadowRoot?.querySelectorAll('li')).toHaveLength(0);
    expect(board.shadowRoot?.activeElement?.className).toContain('disclosure');
  });

  it('plans a trip from two pins with a narrated itinerary', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const FIRA = { ...VALID_PLACE, placeName: 'Fira', city: 'Fira', oneLiner: 'Cliff views.' };
    const VALID_PLAN = {
      stops: ['Oia, Greece', 'Fira, Greece'],
      days: [
        {
          dayTitle: 'Caldera day',
          stopNames: ['Oia, Greece', 'Fira, Greece'],
          summary: 'Walk the caldera path.',
        },
      ],
      nightsEach: [
        { stop: 'Oia, Greece', nights: 2 },
        { stop: 'Fira, Greece', nights: 1 },
      ],
    };
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]))
      .mockResolvedValueOnce(chatResponse(FIRA))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]))
      .mockResolvedValueOnce(chatResponse(VALID_PLAN))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned');
    });
    await mock.session.set({
      tripRequest: READY({
        requestId: '200-2',
        srcUrl: 'https://cdn.example.com/fira.jpg',
      }),
    });
    await waitFor(() => {
      expect(card.shadowRoot?.querySelector('h2')?.textContent).toBe('Fira');
    });
    (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      const board = document.querySelector('trip-board') as HTMLElement;
      expect(board.shadowRoot?.querySelectorAll('li')).toHaveLength(2);
    });
    const board = document.querySelector('trip-board') as HTMLElement;
    const plan = board.shadowRoot?.querySelector('.plan-button') as HTMLButtonElement;
    expect(plan.hasAttribute('aria-disabled')).toBe(false);
    plan.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusItineraryReady');
    });
    expect(card.shadowRoot?.querySelector('h2')?.textContent).toBe('itineraryTitle');
    expect(card.shadowRoot?.querySelectorAll('.stop-list li')).toHaveLength(2);
    const maps = card.shadowRoot?.querySelector('.maps-link') as HTMLAnchorElement;
    expect(maps.href).toContain('maps/dir');
    expect(maps.href).toContain('origin=');
    expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    expect(document.querySelector('#privacy-line')?.textContent).toBe('privacyBoard');
    expect(document.querySelector('#cost-line')?.textContent).toBe('costLine');
    expect((card.shadowRoot?.activeElement as HTMLElement)?.tagName).toBe('H2');
    const [, , , , structure] = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return JSON.parse(init.body as string) as {
        messages: Array<{ content: Array<{ type: string }> }>;
        response_format: { type: string };
      };
    });
    expect(structure.response_format.type).toBe('json_schema');
    expect(structure.messages[1].content[0].type).toBe('text');
  });

  it('renders the scan skeleton while the harvest is collecting', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await mock.session.set({
      tripRequest: READY({
        status: 'collecting',
        srcUrl: '',
        signals: undefined,
        scanImages: [],
      }),
    });
    await waitFor(() => {
      const list = document.querySelector('scan-list');
      expect(list?.shadowRoot?.querySelector('h2')?.textContent).toBe('scanTitle');
    });
    const list = document.querySelector('scan-list');
    const grid = list?.shadowRoot?.querySelector('.skeleton-grid');
    expect(grid?.getAttribute('aria-hidden')).toBe('true');
    expect(grid?.querySelectorAll('.skeleton-block')).toHaveLength(6);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scans the harvest into a paired shortlist', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(
      chatResponse({
        places: [
          { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 1 },
          { placeName: 'Fira', city: 'Fira', country: 'Greece', confidence: 0.8, imageIndex: 9 },
        ],
      }),
    );
    await mock.session.set({
      tripRequest: READY({
        srcUrl: '',
        signals: undefined,
        scanImages: [
          { url: 'https://img.example.com/a.jpg', caption: '', heading: '', width: 800, height: 600 },
          { url: 'https://img.example.com/b.jpg', caption: '', heading: '', width: 800, height: 600 },
        ],
      }),
    });
    await waitFor(() => {
      const list = document.querySelector('scan-list');
      expect(list?.shadowRoot?.querySelectorAll('.scan-card')).toHaveLength(2);
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('scanFound');
    const list = document.querySelector('scan-list');
    const cards = list?.shadowRoot?.querySelectorAll('.scan-card');
    expect(cards?.[0]?.querySelector('img')?.getAttribute('src')).toBe('https://img.example.com/b.jpg');
    expect(cards?.[1]?.querySelector('img')).toBeNull();
    expect(cards?.[1]?.querySelector('.thumb-placeholder')).not.toBeNull();
    expect(cards?.[0]?.querySelector('.pin-button')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows honest cards for empty harvests and empty results', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await mock.session.set({
      tripRequest: READY({ srcUrl: '', signals: undefined, scanImages: [] }),
    });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('scanEmptyTitle');
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(chatResponse({ places: [] }));
    await mock.session.set({
      tripRequest: READY({
        requestId: '200-2',
        srcUrl: '',
        signals: undefined,
        scanImages: [
          { url: 'https://img.example.com/a.jpg', caption: '', heading: '', width: 800, height: 600 },
        ],
      }),
    });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('scanNoneTitle');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams a scan guide with no second identify pass', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(
        chatResponse({
          places: [
            { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 0 },
          ],
        }),
      )
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({
      tripRequest: READY({
        srcUrl: '',
        signals: undefined,
        scanImages: [
          { url: 'https://img.example.com/a.jpg', caption: '', heading: '', width: 800, height: 600 },
        ],
      }),
    });
    await waitFor(() => {
      const list = document.querySelector('scan-list');
      expect(list?.shadowRoot?.querySelectorAll('.scan-card')).toHaveLength(1);
    });
    const list = document.querySelector('scan-list') as HTMLElement;
    (list.shadowRoot?.querySelector('.scan-card button') as HTMLButtonElement).click();
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    await waitFor(() => {
      expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('pins scan cards singly and in bulk', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { listPins } = await import('./board_store');
    fetchMock.mockResolvedValueOnce(
      chatResponse({
        places: [
          { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 0 },
          { placeName: 'Fira', city: 'Fira', country: 'Greece', confidence: 0.8, imageIndex: 1 },
        ],
      }),
    );
    await mock.session.set({
      tripRequest: READY({
        srcUrl: '',
        signals: undefined,
        scanImages: [
          { url: 'https://img.example.com/a.jpg', caption: '', heading: '', width: 800, height: 600 },
          { url: 'https://img.example.com/b.jpg', caption: '', heading: '', width: 800, height: 600 },
        ],
      }),
    });
    await waitFor(() => {
      const list = document.querySelector('scan-list');
      expect(list?.shadowRoot?.querySelectorAll('.scan-card')).toHaveLength(2);
    });
    const list = document.querySelector('scan-list') as HTMLElement;
    const cards = list.shadowRoot?.querySelectorAll('.scan-card');
    (cards?.[0]?.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(async () => {
      expect(await listPins()).toHaveLength(1);
    });
    expect((await listPins())[0]?.imageUrl).toBe('https://img.example.com/a.jpg');
    await waitFor(() => {
      const pressed = document
        .querySelector('scan-list')
        ?.shadowRoot?.querySelectorAll('.scan-card')[0]
        ?.querySelector('.pin-button')
        ?.getAttribute('aria-pressed');
      expect(pressed).toBe('true');
    });
    for (const box of list.shadowRoot?.querySelectorAll('input[type="checkbox"]') ?? []) {
      (box as HTMLInputElement).click();
    }
    (list.shadowRoot?.querySelector('.pin-selected') as HTMLButtonElement).click();
    await waitFor(async () => {
      expect(await listPins()).toHaveLength(2);
    });
  });

  it('retries a failed scan from the error card', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(
        chatResponse({
          places: [
            { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 0 },
          ],
        }),
      );
    await mock.session.set({
      tripRequest: READY({
        srcUrl: '',
        signals: undefined,
        scanImages: [
          { url: 'https://img.example.com/a.jpg', caption: '', heading: '', width: 800, height: 600 },
        ],
      }),
    });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('errorServerTitle');
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.primary') as HTMLButtonElement).click();
    await waitFor(() => {
      const list = document.querySelector('scan-list');
      expect(list?.shadowRoot?.querySelectorAll('.scan-card')).toHaveLength(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('duels the result against a pinned place', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { pinPlace } = await import('./board_store');
    await pinPlace({
      place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira', confidence: 0.8 },
      sourceHost: 'example.com',
    });
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]))
      .mockResolvedValueOnce(
        groundedResponse(
          {
            criteria: [{ criterion: 'Cost', a: 'Pricey sunsets.', b: 'Cheaper stays.' }],
            verdict: 'Pick Oia for views; pick Fira for budget.',
          },
          [{ type: 'url_citation', url: 'https://example.com/cost', title: 'Costs' }],
        ),
      );
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    await waitFor(() => {
      expect(card.shadowRoot?.querySelectorAll('.compare-row option')).toHaveLength(1);
    });
    expect(card.shadowRoot?.querySelector('.compare-row option')?.textContent).toBe('Fira, Greece');
    (card.shadowRoot?.querySelector('.compare-go') as HTMLButtonElement).click();
    await waitFor(() => {
      const table = document.querySelector('compare-table');
      expect(table?.shadowRoot?.querySelectorAll('tbody tr')).toHaveLength(2);
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('duelReady');
    expect(document.querySelector('#privacy-line')?.textContent).toBe('privacyNames');
    const table = document.querySelector('compare-table');
    expect(table?.shadowRoot?.querySelector('caption')?.textContent).toBe('duelCaption');
    expect(table?.shadowRoot?.querySelector('table')?.getAttribute('aria-busy')).toBe('false');
    const chips = document.querySelector('source-chips');
    expect(chips?.shadowRoot?.querySelectorAll('a.chip')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const duelUrl = fetchMock.mock.calls[2][0] as string;
    expect(duelUrl).toContain('/responses');
  });

  it('falls back to chat when duel grounding is rejected', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { pinPlace } = await import('./board_store');
    await pinPlace({
      place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira', confidence: 0.8 },
      sourceHost: 'example.com',
    });
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]))
      .mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockResolvedValueOnce(
        chatResponse({
          criteria: [{ criterion: 'Cost', a: 'Pricey.', b: 'Cheap.' }],
          verdict: 'Pick Oia for views.',
        }),
      );
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('.compare-go')).not.toBeNull();
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.compare-go') as HTMLButtonElement).click();
    await waitFor(() => {
      const table = document.querySelector('compare-table');
      expect(table?.shadowRoot?.querySelectorAll('tbody tr')).toHaveLength(2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(document.querySelector('#sources-slot')?.hasAttribute('hidden')).toBe(true);
  });

  it('retries a failed duel inline without losing the result', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { pinPlace } = await import('./board_store');
    await pinPlace({
      place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira', confidence: 0.8 },
      sourceHost: 'example.com',
    });
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]))
      .mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockResolvedValueOnce(
        chatResponse({
          criteria: [{ criterion: 'Cost', a: 'Pricey.', b: 'Cheap.' }],
          verdict: 'Pick Oia for views.',
        }),
      );
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('.compare-go')).not.toBeNull();
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.compare-go') as HTMLButtonElement).click();
    await waitFor(() => {
      const table = document.querySelector('compare-table');
      expect(table?.shadowRoot?.querySelector('.duel-error p')?.textContent).toBe('duelError');
    });
    expect(card.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    const table = document.querySelector('compare-table') as HTMLElement;
    (table.shadowRoot?.querySelector('.duel-error button') as HTMLButtonElement).click();
    await waitFor(() => {
      const retried = document.querySelector('compare-table');
      expect(retried?.shadowRoot?.querySelectorAll('tbody tr')).toHaveLength(2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('finds alternates and re-plans the trip instead', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]))
      .mockResolvedValueOnce(
        groundedResponse({
          alternatives: [
            { placeName: 'Fira', country: 'Greece', why: 'Same caldera, lower prices.', bestMonth: 'May' },
            { placeName: 'Naxos', country: 'Greece', why: 'Quiet beaches.', bestMonth: 'June' },
          ],
        }),
      )
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    const chips = card.shadowRoot?.querySelectorAll('.chips-row .chip');
    expect(chips).toHaveLength(3);
    (chips?.[0] as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('alternatesReady');
    });
    const fresh = document.querySelector('trip-card') as HTMLElement;
    expect(fresh.shadowRoot?.querySelectorAll('.alternate-card')).toHaveLength(2);
    (fresh.shadowRoot?.querySelector('.alternate-card button') as HTMLButtonElement).click();
    await waitFor(() => {
      const grid = document.querySelector('booking-grid');
      const tiles = grid?.shadowRoot?.querySelectorAll('a.tile');
      expect(tiles?.length).toBeGreaterThan(0);
      expect((tiles?.[0] as HTMLAnchorElement).href).toContain('Fira');
    });
    expect(document.querySelector('#guide-content')?.textContent).toBe('Hello world');
    expect(document.querySelector('#privacy-line')?.textContent).toBe('privacyNames');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('recovers from alternates failure with chips intact', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]))
      .mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.chips-row .chip') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('alternatesFail');
    });
    const fresh = document.querySelector('trip-card') as HTMLElement;
    expect(fresh.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    expect(fresh.shadowRoot?.querySelectorAll('.chips-row .chip')).toHaveLength(3);
    expect(fresh.shadowRoot?.querySelector('.chip[aria-disabled]')).toBeNull();
    expect(fresh.shadowRoot?.querySelector('.alternates-skeletons')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('excludes the current place from duel targets and handles stale picks', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { pinPlace, removePin } = await import('./board_store');
    await pinPlace({ place: VALID_PLACE, sourceHost: 'example.com' });
    await pinPlace({
      place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira', confidence: 0.8 },
      sourceHost: 'example.com',
    });
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelectorAll('.compare-row option')).toHaveLength(1);
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    expect(card.shadowRoot?.querySelector('.compare-row option')?.textContent).toBe('Fira, Greece');
    await removePin('Fira', 'Greece');
    (card.shadowRoot?.querySelector('.compare-go') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('compareStale');
    });
    expect(document.querySelector('compare-table')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries an image-400 with downloaded bytes', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const permsRequest = vi.fn().mockResolvedValue(true);
    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: permsRemove,
    };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() }));
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return {
          getContext: () => ({ drawImage: vi.fn() }),
          convertToBlob: async () => new Blob(['fakejpeg']),
        };
      }),
    );
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelectorAll('button')).toHaveLength(2);
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    const buttons = card.shadowRoot?.querySelectorAll('button');
    expect(buttons?.[1]?.textContent).toBe('fetchRetryButton');
    (buttons?.[1] as HTMLButtonElement).click();
    await waitFor(() => {
      const retried = document.querySelector('trip-card');
      expect(retried?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    await waitFor(() => {
      expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    });
    expect(permsRequest).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[2][0]).toBe('https://cdn.example.com/oia.jpg');
    const retryInit = fetchMock.mock.calls[3][1] as RequestInit;
    const retryBody = JSON.parse(retryInit.body as string) as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const imagePart = retryBody.messages[1].content.find((part) => part.type === 'image_url');
    expect(imagePart?.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('announces denial and hides the fetch button on non-400 errors', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const permsRequest = vi.fn().mockResolvedValue(false);
    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: permsRemove,
    };
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelectorAll('button')).toHaveLength(2);
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    const buttons = card.shadowRoot?.querySelectorAll('button');
    (buttons?.[1] as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('fetchDenied');
    });
    expect(permsRemove).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await mock.session.set({ tripRequest: READY({ requestId: '200-2' }) });
    await waitFor(() => {
      const retry = document.querySelector('trip-card');
      expect(retry?.shadowRoot?.querySelector('h2')?.textContent).toBe('errorServerTitle');
      expect(retry?.shadowRoot?.querySelectorAll('button')).toHaveLength(1);
    });
  });

  it('looks again through a SAM crop', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const permsRequest = vi.fn().mockResolvedValue(true);
    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: permsRemove,
    };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() }));
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return {
          getContext: () => ({ drawImage: vi.fn() }),
          convertToBlob: async () => new Blob(['pixels']),
        };
      }),
    );
    const GUESS = { ...VALID_PLACE, confidence: 0.2 };
    fetchMock
      .mockResolvedValueOnce(chatResponse(GUESS))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'Crop <|box;x1=100;y1=100;x2=600;y2=500;w=1000;h=1000|> here.',
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 900, output_tokens: 40 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('noPlaceTitle');
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.primary') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(card.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(permsRequest).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const samUrl = fetchMock.mock.calls[2][0] as string;
    expect(samUrl).toContain('/responses');
    const samInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect(JSON.parse(samInit.body as string) as { model: string }).toMatchObject({
      model: 'sam-3.1',
    });
    const retryInit = fetchMock.mock.calls[3][1] as RequestInit;
    const retryBody = JSON.parse(retryInit.body as string) as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const imagePart = retryBody.messages[1].content.find((part) => part.type === 'image_url');
    expect(imagePart?.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    const preview = document.querySelector('#preview-frame img') as HTMLImageElement;
    expect(preview.src.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(preview.alt).toBe('previewAltIdentified');
    expect(document.querySelector('.preview-caption')?.textContent).toBe('samZoomCaption');
  });

  it('falls back to the full image when SAM fails or finds nothing', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const permsRequest = vi.fn().mockResolvedValue(true);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() }));
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return {
          getContext: () => ({ drawImage: vi.fn() }),
          convertToBlob: async () => new Blob(['pixels']),
        };
      }),
    );
    const GUESS = { ...VALID_PLACE, confidence: 0.2 };
    const samEmpty = new Response(
      JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '', annotations: [] }] }],
        usage: { input_tokens: 900, output_tokens: 5 },
      }),
      { status: 200 },
    );
    fetchMock
      .mockResolvedValueOnce(chatResponse(GUESS))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]))
      .mockResolvedValueOnce(chatResponse(GUESS))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(samEmpty)
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    const imageOf = (callIndex: number): string | undefined => {
      const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
      const body = JSON.parse(init.body as string) as {
        messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
      };
      return body.messages[1].content.find((part) => part.type === 'image_url')?.image_url?.url;
    };
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('noPlaceTitle');
    });
    let card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.primary') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(card.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(imageOf(3)).toBe('https://cdn.example.com/oia.jpg');
    await mock.session.set({
      tripRequest: READY({ requestId: '200-2', srcUrl: 'https://cdn.example.com/fira.jpg' }),
    });
    await waitFor(() => {
      const retry = document.querySelector('trip-card');
      expect(retry?.shadowRoot?.querySelector('h2')?.textContent).toBe('noPlaceTitle');
    });
    card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.primary') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(card.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(imageOf(8)).toBe('https://cdn.example.com/fira.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('runs fully on-device without a key or consent', async () => {
    const mock = await setup();
    await mock.local.set({
      settings: {
        activeProviderId: 'muse',
        openaiCompat: { baseURL: '', model: '', structuredOutput: 'json_object' },
        imageOnly: false,
        sessionOnly: false,
        preferOnDevice: true,
      },
    });
    installNano(
      ['readily'],
      nanoSession(JSON.stringify(VALID_PLACE), ['## Oia\n\n', 'Hello world']),
    );
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toContain('Oia');
    });
    await waitFor(() => {
      expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    });
    const card = document.querySelector('trip-card');
    expect(card?.shadowRoot?.querySelector('.nano-badge')?.textContent).toBe('nanoBadge');
    expect(document.querySelector('#privacy-line')?.textContent).toBe('privacyLocal');
    expect(document.querySelector('#cost-line')?.textContent).toBe('nanoFreeLine');
    expect(document.querySelector('#status-region')?.textContent).toBe('nanoGuideReady');
    // The only fetch is Nano's plain image probe; no remote API is touched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://cdn.example.com/oia.jpg');
    expect(mock.local.data.has('consentGiven')).toBe(false);
  });

  it('retries a rate limit on-device instead', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('errorRateTitle');
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    const buttons = card.shadowRoot?.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons?.[1]?.textContent).toBe('nanoTryInstead');
    installNano(
      ['readily'],
      nanoSession(JSON.stringify(VALID_PLACE), ['## Oia\n\n', 'Hello world']),
    );
    (buttons?.[1] as HTMLButtonElement).click();
    await waitFor(() => {
      const retried = document.querySelector('trip-card');
      expect(retried?.shadowRoot?.querySelector('h2')?.textContent).toContain('Oia');
    });
    expect(
      document.querySelector('trip-card')?.shadowRoot?.querySelector('.nano-badge'),
    ).not.toBeNull();
    // The 429 plus Nano's plain image probe; no further remote API traffic.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      (mock.local.data.get('settings') as { preferOnDevice: boolean }).preferOnDevice,
    ).toBe(true);
  });

  it('downloads the on-device model from onboarding with sparse milestones', async () => {
    const mock = await setup();
    await mock.local.set({ consentGiven: true });
    const session = nanoSession(JSON.stringify(VALID_PLACE), ['## Oia\n\n', 'Hello world']);
    const availability = vi.fn();
    availability
      .mockResolvedValueOnce('downloadable')
      .mockResolvedValueOnce('downloadable')
      .mockResolvedValue('readily');
    const create = vi.fn().mockImplementation(async (options: { monitor: (m: unknown) => void }) => {
      options.monitor({
        addEventListener: (name: string, fn: (event: { loaded: number }) => void) => {
          fn({ loaded: 0.1 });
          fn({ loaded: 0.6 });
        },
      });
      return session;
    });
    vi.stubGlobal('LanguageModel', { availability, create });
    const statusRegion = document.querySelector('#status-region') as HTMLElement;
    const seen: string[] = [];
    // The observer batches rapid announcements: removed nodes reconstruct
    // the values a current-value read would collapse.
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.removedNodes.forEach((node) => seen.push(node.textContent ?? ''));
        mutation.addedNodes.forEach((node) => seen.push(node.textContent ?? ''));
      }
    }).observe(statusRegion, { childList: true, characterData: true, subtree: true });
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const setupEl = document.querySelector('key-setup');
      expect(setupEl?.shadowRoot?.querySelector('.nano-section button')?.textContent).toBe(
        'nanoTry',
      );
    });
    const setupEl = document.querySelector('key-setup') as HTMLElement;
    (setupEl.shadowRoot?.querySelector('.nano-section button') as HTMLButtonElement).click();
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toContain('Oia');
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(seen).toContain('nanoDownloadStart');
    expect(seen).toContain('nanoDownloadMid');
    expect(seen).toContain('nanoDownloadReady');
    // The only fetch is Nano's plain image probe; no remote API is touched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://cdn.example.com/oia.jpg');
  });

  it('renders honest cards with fallback links for unreadable video', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await mock.session.set({
      tripRequest: READY({
        srcUrl: 'blob:https://example.com/aaa',
        mediaType: 'video',
        frameError: 'drm',
      }),
    });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('errorVideoTitle');
    });
    expect(document.querySelector('#alert-region')?.textContent).toBe('alertVideoUnreadable');
    expect(fetchMock).not.toHaveBeenCalled();
    const card = document.querySelector('trip-card');
    expect(card?.shadowRoot?.querySelector('.fallback a')).not.toBeNull();
    await mock.session.set({
      tripRequest: READY({
        requestId: '300-3',
        srcUrl: 'blob:https://example.com/bbb',
        mediaType: 'video',
        frameError: 'no-match',
      }),
    });
    await waitFor(() => {
      const retry = document.querySelector('trip-card');
      expect(retry?.shadowRoot?.querySelector('h2')?.textContent).toBe('errorVideoMatchTitle');
    });
  });
});
