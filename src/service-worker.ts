import { captureVideoFrame, type CaptureVideoFrameResult } from './injected/capture_video_frame';
import { collectSignals } from './injected/collect_signals';
import { msg } from './utils/i18n';
import { STORAGE_MESSAGE_SCOPE } from './storage_commands';
import { enqueueLocalCommand, handleStorageMessage } from './storage_service';
import {
  HANDOFF_ACK_SCOPE,
  allocateHandoffSeq,
  handleHandoffMessage,
  handoffSlotKey,
  withHandoffSlot,
} from './handoff';
import { reconcileTempGrants } from './grants';

void reconcileTempGrants();

// Queued first, so no cache use precedes the purge.
void enqueueLocalCommand({ kind: 'migrate.run' }).catch(() => undefined);

const MENU_ID = 'plan-trip';

const INJECT_TIMEOUT_MS = 2000;

const MAX_INLINE_DATA_URL = 100000;

let requestCounter = 0;

// In-memory is correct: a restart kills the in-flight handlers this guards,
// and ordering across restarts comes from the persisted sequence.
const latestSeqByWindow = new Map<number, number>();

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: msg('menuTitle'),
      contexts: ['image', 'video'],
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

// The scope filter runs synchronously so foreign messages fall through.
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

const writeCollectingState = (slot: string, record: Record<string, unknown>): Promise<boolean> =>
  withHandoffSlot(async () => {
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
  });

const handleImageClick = async (
  srcUrl: string,
  pageUrl: string | null,
  frameId: number,
  tabId: number,
  windowId: number
): Promise<void> => {
  let seq: number;

  try {
    seq = await allocateHandoffSeq();
  } catch {
    // No sequence, no ordered record: drop the click instead of rejecting.
    return;
  }
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
    frameId,
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
  let seq: number;

  try {
    seq = await allocateHandoffSeq();
  } catch {
    return;
  }
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
  // Race side by side: sequential injections would double the worst case.
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
    frameId,
    windowId,
    at: Date.now(),
    ...(signals ? { signals } : {}),
    mediaType: 'video',
    frame,
    frameError,
  });
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
        // The cast keeps the raw reference: a wrapper closure would break serialization.
        func: collectSignals as unknown as () => void,
        args: [srcUrl],
      }),
      INJECT_TIMEOUT_MS
    );

    const result = (results[0]?.result ?? {}) as Record<string, unknown>;

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
};

// Null means the injection itself failed, distinct from a reported miss.
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
  frameId?: number;
  windowId: number;
  at: number;
  signals?: Record<string, unknown>;
  mediaType?: 'video';
  frame?: { dataUrl: string; time: number };
  frameError?: string;
}

const writeTerminalState = (windowId: number, seq: number, record: TerminalRecord): Promise<void> =>
  withHandoffSlot(async () => {
    const slot = handoffSlotKey(windowId);

    try {
      if (isCurrentSeq(windowId, seq)) {
        await chrome.storage.session.set({ [slot]: record });
      }
    } catch {
      try {
        if (isCurrentSeq(windowId, seq)) {
          const slim: TerminalRecord = { ...record };
          delete slim.signals;

          if (slim.frame) {
            delete slim.frame;
            slim.frameError = 'too-large';
          }
          await chrome.storage.session.set({ [slot]: slim });
        }
      } catch {
        // Last resort: keep the collecting record; the next click recovers.
      }
    }
  });

// No await may sit between the freshness check and the write, or a stale terminal buries a newer collecting record.
const isCurrentSeq = (windowId: number, seq: number): boolean =>
  latestSeqByWindow.get(windowId) === seq;
