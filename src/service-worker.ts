// Minimal service worker for the scaffold and gesture spike: menu wiring,
// open-first panel gesture, request handoff through storage.session, and a
// timeout-raced page-signal scrape with a compare-and-set terminal write.
import { captureVideoFrame, type CaptureVideoFrameResult } from './injected/capture_video_frame';
import { collectPageImages } from './injected/collect_page_images';
import { collectSignals } from './injected/collect_signals';
import type { ScannedImage } from './types';
import { msg } from './utils/i18n';

const MENU_ID = 'plan-trip';
const SCAN_MENU_ID = 'scan-page';
const INJECT_TIMEOUT_MS = 2000;
const MAX_INLINE_DATA_URL = 100000;

let requestCounter = 0;

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: msg('menuTitle'),
      contexts: ['image', 'video'],
    });
    chrome.contextMenus.create({
      id: SCAN_MENU_ID,
      title: msg('scanMenuTitle'),
      contexts: ['page'],
    });
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  if (details.reason === 'install') {
    void chrome.tabs
      .create({ url: chrome.runtime.getURL('onboarding.html') })
      .catch(() => undefined);
  }
});

// Registered at the top level so a cold-start click still wakes the worker.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined) {
    return;
  }
  if (info.menuItemId === SCAN_MENU_ID) {
    // GESTURE RULE: sidePanel.open must run before any await in this handler.
    void chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
    void handleScanClick(info.pageUrl ?? null, info.frameId ?? 0, tab.id, tab.windowId);
    return;
  }
  if (info.menuItemId !== MENU_ID) {
    return;
  }
  // GESTURE RULE: sidePanel.open must run before any await in this handler.
  // Anything awaited first drops the user gesture and open() rejects.
  void chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
  if (info.mediaType === 'video') {
    void handleVideoClick(info.srcUrl ?? '', info.pageUrl ?? null, info.frameId ?? 0, tab.id, tab.windowId);
    return;
  }
  void handleImageClick(info.srcUrl ?? '', info.pageUrl ?? null, info.frameId ?? 0, tab.id, tab.windowId);
});

const handleImageClick = async (
  srcUrl: string,
  pageUrl: string | null,
  frameId: number,
  tabId: number,
  windowId: number
): Promise<void> => {
  requestCounter += 1;
  const requestId = `${Date.now()}-${requestCounter}`;
  // storage.session is small and shared: huge inline payloads stay out of it.
  // The panel treats a blank srcUrl with dataPending as an error state.
  const dataPending = srcUrl.startsWith('data:') && srcUrl.length > MAX_INLINE_DATA_URL;
  const storedSrcUrl = dataPending ? '' : srcUrl;
  await chrome.storage.session.set({
    tripRequest: {
      requestId,
      status: 'collecting',
      srcUrl: storedSrcUrl,
      dataPending,
      pageUrl,
      tabId,
      windowId,
    },
  });
  const signals = await scrapeWithTimeout(tabId, frameId, srcUrl);
  await writeTerminalState(requestId, {
    requestId,
    status: 'ready',
    srcUrl: storedSrcUrl,
    dataPending,
    pageUrl,
    tabId,
    windowId,
    ...(signals ? { signals } : {}),
  });
};

const handleVideoClick = async (
  srcUrl: string,
  pageUrl: string | null,
  frameId: number,
  tabId: number,
  windowId: number
): Promise<void> => {
  requestCounter += 1;
  const requestId = `${Date.now()}-${requestCounter}`;
  const dataPending = srcUrl.startsWith('data:') && srcUrl.length > MAX_INLINE_DATA_URL;
  const storedSrcUrl = dataPending ? '' : srcUrl;
  await chrome.storage.session.set({
    tripRequest: {
      requestId,
      status: 'collecting',
      srcUrl: storedSrcUrl,
      dataPending,
      pageUrl,
      tabId,
      windowId,
      mediaType: 'video',
    },
  });
  // Page signals and the frame capture race side by side: the panel wants
  // both, and sequential injections would double the worst case.
  const [signals, captured] = await Promise.all([
    scrapeWithTimeout(tabId, frameId, srcUrl),
    captureWithTimeout(tabId, frameId, srcUrl),
  ]);
  const frame =
    captured && captured.ok ? { dataUrl: captured.dataUrl, time: captured.time } : undefined;
  const frameError = captured && !captured.ok ? captured.reason : captured ? undefined : 'no-match';
  await writeTerminalState(requestId, {
    requestId,
    status: 'ready',
    srcUrl: storedSrcUrl,
    dataPending,
    pageUrl,
    tabId,
    windowId,
    ...(signals ? { signals } : {}),
    mediaType: 'video',
    frame,
    frameError,
  });
};

const handleScanClick = async (
  pageUrl: string | null,
  frameId: number,
  tabId: number,
  windowId: number
): Promise<void> => {
  requestCounter += 1;
  const requestId = `${Date.now()}-${requestCounter}`;
  await chrome.storage.session.set({
    tripRequest: {
      requestId,
      status: 'collecting',
      srcUrl: '',
      dataPending: false,
      pageUrl,
      tabId,
      windowId,
      scanImages: [],
    },
  });
  const scanImages = await harvestWithTimeout(tabId, frameId);
  await writeTerminalState(requestId, {
    requestId,
    status: 'ready',
    srcUrl: '',
    dataPending: false,
    pageUrl,
    tabId,
    windowId,
    scanImages,
  });
};

const harvestWithTimeout = async (tabId: number, frameId: number): Promise<ScannedImage[]> => {
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: collectPageImages as unknown as () => void,
        args: [],
      }),
      INJECT_TIMEOUT_MS
    );
    const images = (results[0]?.result ?? []) as ScannedImage[];
    return Array.isArray(images) ? images : [];
  } catch {
    return [];
  }
};

const scrapeWithTimeout = async (
  tabId: number,
  frameId: number,
  srcUrl: string
): Promise<Record<string, unknown> | null> => {
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        // chrome-types declares func as () => void; the cast keeps the raw
        // reference (a wrapper closure would break serialization) while the
        // args array still carries srcUrl at runtime.
        func: collectSignals as unknown as () => void,
        args: [srcUrl],
      }),
      INJECT_TIMEOUT_MS
    );
    const result = (results[0]?.result ?? {}) as Record<string, unknown>;
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    // Timeout, missing permission, or a page that refuses injection: the
    // analysis still proceeds, image-only.
    return null;
  }
};

// Null means the injection itself failed (timeout, chrome:// page,
// cross-origin frame): distinct from the function reporting a miss.
const captureWithTimeout = async (
  tabId: number,
  frameId: number,
  srcUrl: string
): Promise<CaptureVideoFrameResult | null> => {
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: captureVideoFrame as unknown as () => void,
        args: [srcUrl],
      }),
      INJECT_TIMEOUT_MS
    );
    return (results[0]?.result ?? null) as CaptureVideoFrameResult | null;
  } catch {
    return null;
  }
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('inject timeout')), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
};

interface TerminalRecord {
  requestId: string;
  status: 'ready';
  srcUrl: string;
  dataPending: boolean;
  pageUrl: string | null;
  tabId: number;
  windowId: number;
  signals?: Record<string, unknown>;
  mediaType?: 'video';
  frame?: { dataUrl: string; time: number };
  frameError?: string;
  scanImages?: ScannedImage[];
}

const writeTerminalState = async (requestId: string, record: TerminalRecord): Promise<void> => {
  try {
    if (await isCurrentRequest(requestId)) {
      await chrome.storage.session.set({ tripRequest: record });
    }
  } catch {
    // Quota or transient failure: retry once with the heavy payloads
    // stripped (a rejected frame surfaces as too-large) so the panel still
    // reaches a terminal state.
    try {
      if (await isCurrentRequest(requestId)) {
        const slim: TerminalRecord = { ...record };
        delete slim.signals;
        if (slim.frame) {
          delete slim.frame;
          slim.frameError = 'too-large';
        }
        if (slim.scanImages) {
          delete slim.scanImages;
        }
        await chrome.storage.session.set({ tripRequest: slim });
      }
    } catch {
      // Last resort: keep the collecting record; the next click recovers.
    }
  }
};

const isCurrentRequest = async (requestId: string): Promise<boolean> => {
  const stored = (await chrome.storage.session.get('tripRequest')) as {
    tripRequest?: { requestId?: string };
  };
  return stored.tripRequest?.requestId === requestId;
};
