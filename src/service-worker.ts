// Minimal service worker for the scaffold and gesture spike: menu wiring,
// open-first panel gesture, request handoff through storage.session, and a
// timeout-raced page-signal scrape with a compare-and-set terminal write.
import { collectSignals } from './injected/collect_signals';

const MENU_ID = 'plan-trip';
const INJECT_TIMEOUT_MS = 2000;
const MAX_INLINE_DATA_URL = 100000;

let requestCounter = 0;

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: chrome.i18n.getMessage('menuTitle'),
      contexts: ['image'],
    });
  });
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

// Registered at the top level so a cold-start click still wakes the worker.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined) {
    return;
  }
  // GESTURE RULE: sidePanel.open must run before any await in this handler.
  // Anything awaited first drops the user gesture and open() rejects.
  void chrome.sidePanel.open({ tabId: tab.id });
  void handleImageClick(info.srcUrl ?? '', info.pageUrl ?? null, info.frameId ?? 0, tab.id);
});

async function handleImageClick(
  srcUrl: string,
  pageUrl: string | null,
  frameId: number,
  tabId: number,
): Promise<void> {
  requestCounter += 1;
  const requestId = `${Date.now()}-${requestCounter}`;
  // storage.session is small and shared: huge inline payloads stay out of it.
  // The panel treats a blank srcUrl with dataPending as "fetch on load".
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
    },
  });
  const signals = await scrapeWithTimeout(tabId, frameId, srcUrl);
  await writeTerminalState(requestId, storedSrcUrl, dataPending, pageUrl, tabId, signals);
}

async function scrapeWithTimeout(
  tabId: number,
  frameId: number,
  srcUrl: string,
): Promise<Record<string, unknown>> {
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
      INJECT_TIMEOUT_MS,
    );
    return (results[0]?.result ?? {}) as Record<string, unknown>;
  } catch {
    // Timeout, missing permission, or a page that refuses injection: the
    // analysis still proceeds, image-only.
    return {};
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('inject timeout')), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

async function writeTerminalState(
  requestId: string,
  srcUrl: string,
  dataPending: boolean,
  pageUrl: string | null,
  tabId: number,
  signals: Record<string, unknown>,
): Promise<void> {
  const record = {
    requestId,
    status: 'ready',
    srcUrl,
    dataPending,
    pageUrl,
    tabId,
    signals,
  };
  try {
    if (await isCurrentRequest(requestId)) {
      await chrome.storage.session.set({ tripRequest: record });
    }
  } catch {
    // Quota or transient failure: retry once with signals stripped so the
    // panel still reaches a terminal state.
    try {
      if (await isCurrentRequest(requestId)) {
        await chrome.storage.session.set({ tripRequest: { ...record, signals: {} } });
      }
    } catch {
      // Last resort: keep the collecting record; the next click recovers.
    }
  }
}

async function isCurrentRequest(requestId: string): Promise<boolean> {
  const stored = (await chrome.storage.session.get('tripRequest')) as {
    tripRequest?: { requestId?: string };
  };
  return stored.tripRequest?.requestId === requestId;
}
