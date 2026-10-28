import { captureVideoFrame, type CaptureVideoFrameResult } from './injected/capture_video_frame';
import { collectPageImages } from './injected/collect_page_images';
import { collectSignals } from './injected/collect_signals';
import type { ScannedImage } from './types';
import { msg } from './utils/i18n';
import { STORAGE_MESSAGE_SCOPE } from './storage_commands';
import { enqueueLocalCommand, handleStorageMessage } from './storage_service';
import {
  HANDOFF_ACK_SCOPE,
  allocateHandoffSeq,
  handleHandoffMessage,
  handoffSlotKey,
} from './handoff';

const MENU_ID = 'plan-trip';

const SCAN_MENU_ID = 'scan-page';

const INJECT_TIMEOUT_MS = 2000;

const MAX_INLINE_DATA_URL = 100000;

let requestCounter = 0;

// Freshness per window, checked synchronously before terminal writes so a
// superseded click can never bury a newer collecting record. In-memory is
// correct here: a worker restart kills the in-flight handlers the map
// guards, and ordering across restarts comes from the persisted sequence.
const latestSeqByWindow = new Map<number, number>();

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
  } else if (details.reason === 'update') {
    void enqueueLocalCommand({ kind: 'migrate.run' }).catch(() => undefined);
  }
});

// Single-writer storage commands from extension pages. The scope filter runs
// synchronously so foreign messages fall through to other listeners.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    !message ||
    typeof message !== 'object' ||
    (message as { scope?: unknown }).scope !== STORAGE_MESSAGE_SCOPE
  ) {
    return false;
  }

  void handleStorageMessage(message, sender).then(sendResponse);

  return true;
});

// Handoff acknowledgements from panels: the worker clears a window slot
// only when the acknowledged sequence still matches.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    !message ||
    typeof message !== 'object' ||
    (message as { scope?: unknown }).scope !== HANDOFF_ACK_SCOPE
  ) {
    return false;
  }

  void handleHandoffMessage(message, sender).then(sendResponse);

  return true;
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
    void handleVideoClick(
      info.srcUrl ?? '',
      info.pageUrl ?? null,
      info.frameId ?? 0,
      tab.id,
      tab.windowId
    );

    return;
  }
  void handleImageClick(
    info.srcUrl ?? '',
    info.pageUrl ?? null,
    info.frameId ?? 0,
    tab.id,
    tab.windowId
  );
});

const nextRequestId = (): string => {
  requestCounter += 1;

  return `${Date.now()}-${requestCounter}`;
};

// The collecting write is the click's only visible trace: if it fails, the
// panel gets an error record instead of silence. When even that fails the
// worker has no channel left; the opened panel stays idle.
const writeCollectingState = async (
  slot: string,
  record: Record<string, unknown>
): Promise<boolean> => {
  try {
    await chrome.storage.session.set({ [slot]: record });

    return true;
  } catch {
    try {
      await chrome.storage.session.set({
        [slot]: { ...record, status: 'error', reason: 'collecting-failed' },
      });
    } catch {
      // No channel left; the opened panel stays idle.
    }

    return false;
  }
};

const handleImageClick = async (
  srcUrl: string,
  pageUrl: string | null,
  frameId: number,
  tabId: number,
  windowId: number
): Promise<void> => {
  const seq = await allocateHandoffSeq();
  latestSeqByWindow.set(windowId, seq);

  const requestId = nextRequestId();
  // storage.session is small and shared: huge inline payloads stay out of it.
  // The panel treats a blank srcUrl with dataPending as an error state.
  const dataPending = srcUrl.startsWith('data:') && srcUrl.length > MAX_INLINE_DATA_URL;

  const storedSrcUrl = dataPending ? '' : srcUrl;
  const slot = handoffSlotKey(windowId);
  const collecting = await writeCollectingState(slot, {
    requestId,
    seq,
    status: 'collecting',
    srcUrl: storedSrcUrl,
    dataPending,
    pageUrl,
    tabId,
    windowId,
    at: Date.now(),
  });

  if (!collecting) {
    return;
  }

  const signals = await scrapeWithTimeout(tabId, frameId, srcUrl);
  await writeTerminalState(windowId, seq, {
    requestId,
    seq,
    status: 'ready',
    srcUrl: storedSrcUrl,
    dataPending,
    pageUrl,
    tabId,
    windowId,
    at: Date.now(),
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

  const seq = await allocateHandoffSeq();
  latestSeqByWindow.set(windowId, seq);

  const requestId = nextRequestId();

  const dataPending = srcUrl.startsWith('data:') && srcUrl.length > MAX_INLINE_DATA_URL;

  const storedSrcUrl = dataPending ? '' : srcUrl;
  const slot = handoffSlotKey(windowId);
  const collecting = await writeCollectingState(slot, {
    requestId,
    seq,
    status: 'collecting',
    srcUrl: storedSrcUrl,
    dataPending,
    pageUrl,
    tabId,
    windowId,
    at: Date.now(),
    mediaType: 'video',
  });

  if (!collecting) {
    return;
  }
  // Page signals and the frame capture race side by side: the panel wants
  // both, and sequential injections would double the worst case.
  const [signals, captured] = await Promise.all([
    scrapeWithTimeout(tabId, frameId, srcUrl),
    captureWithTimeout(tabId, frameId, srcUrl),
  ]);

  const frame =
    captured && captured.ok ? { dataUrl: captured.dataUrl, time: captured.time } : undefined;

  const frameError = captured && !captured.ok ? captured.reason : captured ? undefined : 'no-match';
  await writeTerminalState(windowId, seq, {
    requestId,
    seq,
    status: 'ready',
    srcUrl: storedSrcUrl,
    dataPending,
    pageUrl,
    tabId,
    windowId,
    at: Date.now(),
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
  const seq = await allocateHandoffSeq();
  latestSeqByWindow.set(windowId, seq);

  const requestId = nextRequestId();
  const slot = handoffSlotKey(windowId);
  const collecting = await writeCollectingState(slot, {
    requestId,
    seq,
    status: 'collecting',
    srcUrl: '',
    dataPending: false,
    pageUrl,
    tabId,
    windowId,
    at: Date.now(),
    scanImages: [],
  });

  if (!collecting) {
    return;
  }

  const scanImages = await harvestWithTimeout(tabId, frameId);
  await writeTerminalState(windowId, seq, {
    requestId,
    seq,
    status: 'ready',
    srcUrl: '',
    dataPending: false,
    pageUrl,
    tabId,
    windowId,
    at: Date.now(),
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
  seq: number;
  status: 'ready';
  srcUrl: string;
  dataPending: boolean;
  pageUrl: string | null;
  tabId: number;
  windowId: number;
  at: number;
  signals?: Record<string, unknown>;
  mediaType?: 'video';
  frame?: { dataUrl: string; time: number };
  frameError?: string;
  scanImages?: ScannedImage[];
}

const writeTerminalState = async (
  windowId: number,
  seq: number,
  record: TerminalRecord
): Promise<void> => {
  const slot = handoffSlotKey(windowId);

  try {
    if (isCurrentSeq(windowId, seq)) {
      await chrome.storage.session.set({ [slot]: record });
    }
  } catch {
    // Quota or transient failure: retry once with the heavy payloads
    // stripped (a rejected frame surfaces as too-large) so the panel still
    // reaches a terminal state.
    try {
      if (isCurrentSeq(windowId, seq)) {
        const slim: TerminalRecord = { ...record };
        delete slim.signals;

        if (slim.frame) {
          delete slim.frame;
          slim.frameError = 'too-large';
        }

        if (slim.scanImages) {
          delete slim.scanImages;
        }
        await chrome.storage.session.set({ [slot]: slim });
      }
    } catch {
      // Last resort: keep the collecting record; the next click recovers.
    }
  }
};

// Synchronous by design: no await may sit between the freshness check and
// the write, or a newer click's collecting record lands in the gap and the
// stale terminal write buries it.
const isCurrentSeq = (windowId: number, seq: number): boolean =>
  latestSeqByWindow.get(windowId) === seq;
