import { afterEach, describe, expect, it, vi } from 'vitest';
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

const storedRequest = async (mock: ChromeMock): Promise<Record<string, unknown>> =>
  (await mock.session.get('tripRequest'))['tripRequest'] as Record<string, unknown>;

describe('service-worker', () => {
  it('wires menus, panel behavior, and onboarding on install', async () => {
    const mock = await setup();

    for (const fn of mock.worker.installed) {
      fn({ reason: 'install' });
    }
    await flush();
    expect(mock.worker.menus.map((menu) => menu['id'])).toEqual(['plan-trip', 'scan-page']);
    expect(mock.worker.menus[0]['contexts']).toEqual(['image', 'video']);
    expect(mock.worker.menus[1]['contexts']).toEqual(['page']);
    expect(mock.worker.panelBehaviors).toEqual([{ openPanelOnActionClick: true }]);
    expect(mock.worker.tabsCreated).toEqual([{ url: 'chrome-extension://test/onboarding.html' }]);
  });

  it('migrates legacy stores on update', async () => {
    const mock = await setup();
    await mock.local.set({
      settings: { activeProviderId: 'muse' },
      tripBoard: [
        {
          place: {
            identified: true,
            placeName: 'Oia',
            city: 'Oia',
            country: 'Greece',
            confidence: 0.9,
            oneLiner: 'Blue domes.',
          },
          sourceHost: 'example.com',
          addedAt: 42,
        },
      ],
      costTotals: { '2026-03': 1.5 },
    });

    for (const fn of mock.worker.installed) {
      fn({ reason: 'update' });
    }
    await flush();
    expect(mock.local.data.get('settings')).toEqual({
      v: 1,
      settings: { activeProviderId: 'muse' },
    });
    expect(mock.local.data.get('tripBoard')).toMatchObject({ v: 1 });
    expect(mock.local.data.get('costTotals')).toEqual({ v: 1, months: { '2026-03': 1.5 } });
  });

  it('hands off image clicks as collecting then schema-valid ready', async () => {
    const mock = await setup();

    const statuses: unknown[] = [];
    mock.session.onChanged.addListener((changes) => {
      statuses.push((changes['tripRequest']?.newValue as { status?: unknown } | undefined)?.status);
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

  it('hands off page scans with the harvested images', async () => {
    const mock = await setup();

    const images = [
      { url: 'https://cdn.example.com/a.jpg', caption: '', heading: '', width: 4, height: 3 },
    ];
    mock.worker.scriptingImpl = async () => [{ result: images }];
    fireClick(
      mock,
      { menuItemId: 'scan-page', pageUrl: 'https://example.com/guide', frameId: 0 },
      { ...TAB }
    );
    await flush();

    const record = await storedRequest(mock);
    expect(TRIP_REQUEST_SCHEMA.safeParse(record).success).toBe(true);
    expect(record['scanImages']).toEqual(images);
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
    // The first click is past its scrape and into its terminal write while
    // the second click arrives: a get-then-set gap here would let the stale
    // write bury the newer collecting record.
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

  it('ignores clicks without a tab and unknown menu items', async () => {
    const mock = await setup();
    fireClick(mock, { ...IMAGE_INFO }, {});
    fireClick(mock, { ...IMAGE_INFO, menuItemId: 'nope' }, { ...TAB });
    await flush();
    expect(await mock.session.get('tripRequest')).toEqual({});
    expect(mock.worker.sidePanelOpens).toEqual([]);
  });
});
