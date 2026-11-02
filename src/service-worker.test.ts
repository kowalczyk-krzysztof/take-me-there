import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEMP_GRANT_KEY } from './grants';
import type { ChromeMock } from './test/chrome_mock';
import { installChromeMock, uninstallChromeMock } from './test/chrome_mock';
import { TRIP_REQUEST_SCHEMA } from './types';

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

const IMAGE_INFO = {
  menuItemId: 'plan-trip',
  srcUrl: 'https://cdn.example.com/oia.jpg',
  pageUrl: 'https://example.com/guide',
  frameId: 0,
};

const TAB = { id: 7, windowId: 3 };

const setup = async (): Promise<ChromeMock> => {
  vi.resetModules();

  const mock = installChromeMock();
  await import('./service-worker');

  return mock;
};

afterEach(() => {
  uninstallChromeMock();
});

const flush = async (ms = 20): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const fireClick = (
  mock: ChromeMock,
  info: Record<string, unknown>,
  tab: Record<string, unknown>
): void => {
  for (const fn of mock.worker.menuClicked) {
    fn(info, tab);
  }
};

const storedRequest = async (mock: ChromeMock, windowId = 3): Promise<Record<string, unknown>> =>
  (await mock.session.get(`tripRequest:${windowId}`))[`tripRequest:${windowId}`] as Record<
    string,
    unknown
  >;

describe('service-worker', () => {
  it('reconciles abandoned temp grants on startup', async () => {
    vi.resetModules();

    const mock = installChromeMock();

    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      remove: permsRemove,
      contains: vi.fn().mockResolvedValue(false),
      getAll: vi.fn().mockResolvedValue({ origins: [] }),
    };

    await mock.session.set({
      [TEMP_GRANT_KEY]: { 'https://old.example.com': Date.now() - 11 * 60 * 1000 },
    });
    await import('./service-worker');
    await flush();

    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://old.example.com/*'] });
    expect(await mock.session.get(TEMP_GRANT_KEY)).toEqual({});
    expect(await mock.local.get(TEMP_GRANT_KEY)).toEqual({ [TEMP_GRANT_KEY]: {} });
  });

  it('reconciles journal strays when the retry alarm fires', async () => {
    vi.resetModules();

    const mock = installChromeMock();

    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      remove: permsRemove,
      contains: vi.fn().mockResolvedValue(false),
      getAll: vi.fn().mockResolvedValue({ origins: [] }),
    };

    const listeners: Array<(alarm: { name: string }) => void> = [];
    (chrome as unknown as { alarms: unknown }).alarms = {
      onAlarm: {
        addListener: (fn: (alarm: { name: string }) => void): void => {
          listeners.push(fn);
        },
      },
    };

    await import('./service-worker');
    await flush();
    expect(listeners).toHaveLength(1);

    await mock.local.set({
      [TEMP_GRANT_KEY]: { 'https://stray.example.com': { count: 0, at: 0 } },
    });

    for (const fn of listeners) {
      fn({ name: 'take-me-there-grant-reconcile' });
    }
    await flush();

    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://stray.example.com/*'] });
    expect(await mock.local.get(TEMP_GRANT_KEY)).toEqual({ [TEMP_GRANT_KEY]: {} });
  });

  it('wires menus, panel behavior, and onboarding on install', async () => {
    const mock = await setup();

    for (const fn of mock.worker.installed) {
      fn({ reason: 'install' });
    }
    await flush();
    expect(mock.worker.menus.map((menu) => menu['id'])).toEqual(['plan-trip']);
    expect(mock.worker.menus[0]['contexts']).toEqual(['image', 'video']);
    expect(mock.worker.panelBehaviors).toEqual([{ openPanelOnActionClick: true }]);
    expect(mock.worker.tabsCreated).toEqual([{ url: 'chrome-extension://test/onboarding.html' }]);
  });

  it('migrates legacy stores on update', async () => {
    const mock = await setup();
    await mock.local.set({
      settings: { imageOnly: false },
      costTotals: { '2026-03': 1.5 },
    });

    for (const fn of mock.worker.installed) {
      fn({ reason: 'update' });
    }
    await flush();
    expect(mock.local.data.get('settings')).toEqual({
      v: 1,
      settings: { imageOnly: false },
    });
    expect(mock.local.data.get('costTotals')).toEqual({ v: 1, months: { '2026-03': 1.5 } });
  });

  it('hands off image clicks as collecting then schema-valid ready', async () => {
    const mock = await setup();

    const statuses: unknown[] = [];
    mock.session.onChanged.addListener((changes) => {
      const change = changes['tripRequest:3']?.newValue as { status?: unknown } | undefined;

      if (change) {
        statuses.push(change.status);
      }
    });
    fireClick(mock, { ...IMAGE_INFO }, { ...TAB });
    await flush();
    expect(mock.worker.sidePanelOpens).toEqual([{ tabId: 7 }]);
    expect(statuses).toEqual(['collecting', 'ready']);
    expect(mock.worker.scriptingCalls).toHaveLength(1);
    expect(mock.worker.scriptingCalls[0].args).toEqual(['https://cdn.example.com/oia.jpg']);

    const record = await storedRequest(mock);
    expect(TRIP_REQUEST_SCHEMA.safeParse(record).success).toBe(true);
    expect(record).not.toHaveProperty('signals');
    expect(record['tabId']).toBe(7);
    expect(record['windowId']).toBe(3);
    expect(typeof record['at']).toBe('number');
    expect(record['seq']).toBe(1);
  });

  it('stamps terminal records with the click frame', async () => {
    const mock = await setup();
    mock.worker.scriptingImpl = async () => [{ result: SIGNALS }];
    fireClick(mock, { ...IMAGE_INFO, frameId: 9 }, { ...TAB });
    await flush();

    const record = await storedRequest(mock);
    expect(TRIP_REQUEST_SCHEMA.safeParse(record).success).toBe(true);
    expect(record['frameId']).toBe(9);
  });

  it('attaches page signals when the scrape succeeds', async () => {
    const mock = await setup();
    mock.worker.scriptingImpl = async () => [{ result: SIGNALS }];
    fireClick(mock, { ...IMAGE_INFO }, { ...TAB });
    await flush();

    const record = await storedRequest(mock);
    expect(TRIP_REQUEST_SCHEMA.safeParse(record).success).toBe(true);
    expect(record['signals']).toMatchObject({ imgFound: true, alt: 'Blue domes' });
  });

  it('hands off video clicks with the captured frame', async () => {
    const mock = await setup();
    mock.worker.scriptingImpl = async (call) => {
      if ((call.func as { name?: string }).name === 'captureVideoFrame') {
        return [{ result: { ok: true, dataUrl: 'data:image/jpeg,frame', time: 4.2 } }];
      }

      return [{ result: null }];
    };
    fireClick(
      mock,
      { ...IMAGE_INFO, mediaType: 'video', srcUrl: 'https://cdn.example.com/a.mp4' },
      { ...TAB }
    );
    await flush();

    const record = await storedRequest(mock);
    expect(TRIP_REQUEST_SCHEMA.safeParse(record).success).toBe(true);
    expect(record['mediaType']).toBe('video');
    expect(record['frame']).toEqual({ dataUrl: 'data:image/jpeg,frame', time: 4.2 });
    expect(record['frameError']).toBeUndefined();
  });

  it('skips capture when a video click carries no source URL', async () => {
    const mock = await setup();
    const info = { ...IMAGE_INFO, mediaType: 'video' };
    delete (info as { srcUrl?: string }).srcUrl;
    fireClick(mock, info, { ...TAB });
    await flush();

    const record = await storedRequest(mock);
    expect(TRIP_REQUEST_SCHEMA.safeParse(record).success).toBe(true);
    expect(record['srcUrl']).toBe('');
    expect(record['frame']).toBeUndefined();
    expect(record['frameError']).toBe('no-match');
    expect(
      mock.worker.scriptingCalls.filter(
        (call) => (call.func as { name?: string }).name === 'captureVideoFrame'
      )
    ).toHaveLength(0);
  });

  it('marks video clicks when the frame capture misses', async () => {
    const mock = await setup();
    fireClick(
      mock,
      { ...IMAGE_INFO, mediaType: 'video', srcUrl: 'https://cdn.example.com/a.mp4' },
      { ...TAB }
    );
    await flush();

    const record = await storedRequest(mock);
    expect(TRIP_REQUEST_SCHEMA.safeParse(record).success).toBe(true);
    expect(record['frame']).toBeUndefined();
    expect(record['frameError']).toBe('no-match');
  });

  it('lets the newest click win when it lands mid-write', async () => {
    const mock = await setup();

    const releases: Array<(value: Array<{ result: unknown }>) => void> = [];
    mock.worker.scriptingImpl = () =>
      new Promise<Array<{ result: unknown }>>((resolve) => {
        releases.push(resolve);
      });
    fireClick(mock, { ...IMAGE_INFO }, { ...TAB });
    await flush(0);
    releases[0]([{ result: null }]);
    // The second click arrives mid-terminal-write: a get-then-set gap would let the stale write bury it.
    await flush(0);
    fireClick(mock, { ...IMAGE_INFO, srcUrl: 'https://cdn.example.com/fira.jpg' }, { ...TAB });
    await flush(15);
    releases[1]([{ result: null }]);
    await flush();

    const record = await storedRequest(mock);
    expect(record['srcUrl']).toBe('https://cdn.example.com/fira.jpg');
  });

  it('blanks oversized inline payloads and flags them pending', async () => {
    const mock = await setup();
    fireClick(mock, { ...IMAGE_INFO, srcUrl: `data:image/jpeg,${'x'.repeat(100001)}` }, { ...TAB });
    await flush();

    const record = await storedRequest(mock);
    expect(TRIP_REQUEST_SCHEMA.safeParse(record).success).toBe(true);
    expect(record['srcUrl']).toBe('');
    expect(record['dataPending']).toBe(true);
  });

  it('routes storage commands from extension pages and ignores foreign messages', async () => {
    const mock = await setup();

    expect(mock.runtime.listeners).toHaveLength(2);

    const listener = mock.runtime.listeners[0];

    const responses: Array<unknown> = [];

    const handled = listener(
      { scope: 'take-me-there/storage-v1', command: { kind: 'spend.record', amountUsd: 2, at: 1 } },
      { id: 'test', url: 'chrome-extension://test/sidepanel.html' },
      (response: unknown) => {
        responses.push(response);
      }
    );
    expect(handled).toBe(true);
    await flush();
    expect(responses).toEqual([{ ok: true, value: 2 }]);

    const totals = (await mock.local.get('costTotals')) as {
      costTotals: { v: number; months: Record<string, number> };
    };
    expect(totals.costTotals.v).toBe(1);

    const foreign = listener({ scope: 'elsewhere' }, { id: 'test' }, () => undefined);
    expect(foreign).toBe(false);
    expect(mock.runtime.sent).toEqual([]);
  });

  it('ignores clicks without a tab and unknown menu items', async () => {
    const mock = await setup();
    fireClick(mock, { ...IMAGE_INFO }, {});
    fireClick(mock, { ...IMAGE_INFO, menuItemId: 'nope' }, { ...TAB });
    await flush();
    expect(await mock.session.get('tripRequest:3')).toEqual({});
    expect(mock.worker.sidePanelOpens).toEqual([]);
  });

  it('delivers each window its own slot without cross-window suppression', async () => {
    const mock = await setup();

    const releases: Array<(value: Array<{ result: unknown }>) => void> = [];
    mock.worker.scriptingImpl = () =>
      new Promise<Array<{ result: unknown }>>((resolve) => {
        releases.push(resolve);
      });
    fireClick(mock, { ...IMAGE_INFO }, { ...TAB });
    await flush(0);
    fireClick(
      mock,
      { ...IMAGE_INFO, srcUrl: 'https://cdn.example.com/fira.jpg' },
      { id: 9, windowId: 5 }
    );
    await flush(0);
    releases[0]([{ result: null }]);
    releases[1]([{ result: null }]);
    await flush();

    const first = await storedRequest(mock, 3);
    const second = await storedRequest(mock, 5);
    expect(first['srcUrl']).toBe('https://cdn.example.com/oia.jpg');
    expect(second['srcUrl']).toBe('https://cdn.example.com/fira.jpg');
    expect(first['seq']).toBe(1);
    expect(second['seq']).toBe(2);
  });

  it('continues the persisted sequence after a worker restart', async () => {
    const mock = await setup();
    await mock.session.set({ handoffSeq: 41 });

    // The fresh worker registers a second click listener; only the newest handles.
    vi.resetModules();
    await import('./service-worker');
    mock.worker.menuClicked.splice(0, mock.worker.menuClicked.length - 1);

    fireClick(mock, { ...IMAGE_INFO }, { ...TAB });
    await flush();

    const record = await storedRequest(mock);
    expect(record['seq']).toBe(42);
    expect(mock.session.data.get('handoffSeq')).toBe(42);
  });

  it('clears only the acknowledged sequence and ignores delayed acks', async () => {
    const mock = await setup();

    const { handleHandoffMessage } = await import('./handoff');
    const sender = { id: 'test', url: 'chrome-extension://test/sidepanel.html' };

    await mock.session.set({
      'tripRequest:3': { requestId: '9-1', seq: 6, status: 'ready' },
    });

    await expect(
      handleHandoffMessage({ scope: 'take-me-there/handoff-v1', windowId: 3, seq: 5 }, sender)
    ).resolves.toEqual({ ok: true, cleared: false });
    expect(mock.session.data.has('tripRequest:3')).toBe(true);

    await expect(
      handleHandoffMessage({ scope: 'take-me-there/handoff-v1', windowId: 3, seq: 6 }, sender)
    ).resolves.toEqual({ ok: true, cleared: true });
    expect(mock.session.data.has('tripRequest:3')).toBe(false);

    await expect(handleHandoffMessage({ scope: 'elsewhere' }, sender)).resolves.toBeUndefined();
    await expect(
      handleHandoffMessage({ scope: 'take-me-there/handoff-v1', windowId: 3, seq: 'x' }, sender)
    ).resolves.toEqual({ ok: false, error: 'invalid payload' });
  });

  it('routes handoff acks through the worker message listener', async () => {
    const mock = await setup();
    expect(mock.runtime.listeners).toHaveLength(2);

    await mock.session.set({
      'tripRequest:3': { requestId: '9-1', seq: 6, status: 'ready' },
    });

    const responses: Array<unknown> = [];
    const handled = mock.runtime.listeners[1](
      { scope: 'take-me-there/handoff-v1', windowId: 3, seq: 6 },
      { id: 'test', url: 'chrome-extension://test/sidepanel.html' },
      (response: unknown) => {
        responses.push(response);
      }
    );
    expect(handled).toBe(true);
    await flush();
    expect(responses).toEqual([{ ok: true, cleared: true }]);
    expect(mock.session.data.has('tripRequest:3')).toBe(false);
  });

  it('surfaces a schema-valid error record when the collecting write fails', async () => {
    const mock = await setup();

    let sets = 0;
    mock.session.fault = (op) => {
      if (op === 'set') {
        sets += 1;

        if (sets === 2) {
          throw new Error('transient');
        }
      }
    };

    fireClick(mock, { ...IMAGE_INFO }, { ...TAB });
    await flush();

    const record = await storedRequest(mock);
    expect(TRIP_REQUEST_SCHEMA.safeParse(record).success).toBe(true);
    expect(record['status']).toBe('error');
    expect(record['seq']).toBe(1);
  });
});
