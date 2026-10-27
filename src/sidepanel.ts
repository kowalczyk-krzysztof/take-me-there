// Panel state machine: handoff intake, key and consent gates, cached or live
// analysis with streamed guides, disagree flows, and the cost footer.
import './components/booking_grid';
import './components/key_setup';
import './components/source_chips';
import './components/trip_board';
import './components/trip_card';
import type { BookingGridElement } from './components/booking_grid';
import type {
  ConsentDecisionDetail,
  KeySaveRequestDetail,
  KeySetupElement,
  SessionOnlyChangeDetail,
} from './components/key_setup';
import type { SourceChipsElement } from './components/source_chips';
import type {
  BoardItemView,
  TripBoardElement,
  TripRemovePinDetail,
} from './components/trip_board';
import type { TripCardElement } from './components/trip_card';
import { adoptSharedStyles, prefersReducedMotion } from './components/shared_styles';
import {
  clearBoard,
  dedupeKeyFor,
  listPins,
  makeThumbnail,
  pinPlace,
  removePin,
  type BoardPin,
} from './board_store';
import { buildDestination, buildLinks, mapsDirUrl } from './deep_links';
import { loadKey, saveKey } from './key_vault';
import { estimateCostUsd, formatUsd, recordMonthSpend } from './pricing';
import { createGuideRenderer, findGuideStart } from './render_markdown';
import {
  TRIP_REQUEST_SCHEMA,
  type ItineraryPlan,
  type PageSignals,
  type PlaceResult,
  type TripRequest,
} from './types';
import {
  frameCacheSeed,
  hasVideoConsented,
  isMp4RungUsable,
  setVideoConsented,
} from './video';
import {
  ProviderError,
  addUsage,
  emptyUsage,
  formatSignalsForPrompt,
  getActiveProvider,
  hasConsented,
  loadSettings,
  saveSettings,
  setConsented,
  sanitizePromptHint,
  type ExtensionSettings,
  type GuideSource,
  type Provider,
  type Usage,
} from './providers/index';

const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);

const SKELETON_DELAY_MS = 200;
const SKELETON_MIN_MS = 300;
const STALE_COLLECTING_MS = 5000;
const MAX_PREVIEW_DATA_URL = 2000000;
const CACHE_SLOTS = 10;
const CACHE_INDEX_KEY = 'cacheKeys';
const SCROLL_NEAR_BOTTOM_PX = 80;

export interface CacheEntry {
  place: PlaceResult;
  guide: string;
  sources: GuideSource[];
  usage: Usage;
  searchedWeb: boolean;
}

export const isAllowedPreviewUrl = (srcUrl: string): boolean => {
  if (srcUrl.startsWith('data:')) {
    return srcUrl.length <= MAX_PREVIEW_DATA_URL && srcUrl.startsWith('data:image/');
  }
  try {
    const parsed = new URL(srcUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

export const hashCacheKey = async (srcUrl: string, pageUrl: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${srcUrl}|${pageUrl}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const cacheKeyFor = (hash: string): string => `cache:${hash}`;

const isCacheEntry = (value: unknown): value is CacheEntry => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Partial<CacheEntry>;
  return (
    typeof entry.guide === 'string' &&
    Array.isArray(entry.sources) &&
    !!entry.place &&
    typeof entry.place === 'object' &&
    typeof (entry.place as PlaceResult).placeName === 'string' &&
    !!entry.usage &&
    typeof entry.usage === 'object'
  );
};

const readCacheIndex = async (): Promise<string[]> => {
  try {
    const stored = (await chrome.storage.session.get(CACHE_INDEX_KEY)) as {
      cacheKeys?: unknown;
    };
    return Array.isArray(stored.cacheKeys)
      ? stored.cacheKeys.filter((key): key is string => typeof key === 'string')
      : [];
  } catch {
    return [];
  }
};

export const getCacheEntry = async (hash: string): Promise<CacheEntry | undefined> => {
  try {
    const stored = (await chrome.storage.session.get(cacheKeyFor(hash))) as Record<string, unknown>;
    const entry = stored[cacheKeyFor(hash)];
    if (!isCacheEntry(entry)) {
      return undefined;
    }
    const index = (await readCacheIndex()).filter((key) => key !== hash);
    index.unshift(hash);
    await chrome.storage.session.set({ [CACHE_INDEX_KEY]: index.slice(0, CACHE_SLOTS) });
    return entry;
  } catch {
    return undefined;
  }
};

export const setCacheEntry = async (hash: string, entry: CacheEntry): Promise<void> => {
  try {
    await chrome.storage.session.set({ [cacheKeyFor(hash)]: entry });
    const index = (await readCacheIndex()).filter((key) => key !== hash);
    index.unshift(hash);
    const evicted = index.slice(CACHE_SLOTS);
    await chrome.storage.session.set({ [CACHE_INDEX_KEY]: index.slice(0, CACHE_SLOTS) });
    for (const key of evicted) {
      await chrome.storage.session.remove(cacheKeyFor(key));
    }
  } catch {
    // Cache writes are best-effort; a failure never breaks the analysis.
  }
};

const EMPTY_SIGNALS: PageSignals = {
  imgFound: false,
  alt: '',
  imgTitle: '',
  figcaption: '',
  nearestHeading: '',
  nearestParagraph: '',
  ogTitle: '',
  ogDescription: '',
  ogSiteName: '',
  docTitle: '',
  metaDescription: '',
  canonical: '',
  pageHost: '',
  urlSlug: '',
  imgFileSlug: '',
  jsonLd: [],
};

type PendingRun = { kind: 'request'; request: TripRequest } | { kind: 'itinerary' };

let initialized = false;
let pageTitle: HTMLElement;
let previewHeading: HTMLElement;
let previewFrame: HTMLElement;
let statusRegion: HTMLElement;
let alertRegion: HTMLElement;
let resultSlot: HTMLElement;
let linksSlot: HTMLElement;
let guideSlot: HTMLElement;
let searchLine: HTMLElement;
let guideContent: HTMLElement;
let sourcesSlot: HTMLElement;
let sourcesHeading: HTMLElement;
let privacyLine: HTMLElement;
let linksNoteSummary: HTMLElement;
let linksNoteBody: HTMLElement;
let costLine: HTMLElement;
let tripCard: TripCardElement;
let keySetup: KeySetupElement;
let bookingGrid: BookingGridElement;
let sourceChips: SourceChipsElement;
let boardSlot: HTMLElement;
let tripBoard: TripBoardElement;
let failedPin: Omit<BoardPin, 'addedAt'> | null = null;
let failedRemove: TripRemovePinDetail | null = null;

let highestRequestId = '';
let highestStatusRank = -1;
let activeController: AbortController | null = null;
let analysisInFlight = false;
let currentRunId: string | null = null;
let runUsage: Usage = emptyUsage();
let activeRequest: TripRequest | null = null;
let activeProvider: Provider | null = null;
let runSettings: ExtensionSettings | null = null;
let pendingRun: PendingRun | null = null;
let lastRun: PendingRun | null = null;
let currentCacheKey = '';
let currentPlace: PlaceResult | null = null;
let currentDestination = '';
let currentSources: GuideSource[] = [];
let currentView = '';
let shortcutText = '';
let skeletonTimer: ReturnType<typeof setTimeout> | undefined;
let skeletonFor = '';
let skeletonShownAt = 0;
let staleTimer: ReturnType<typeof setTimeout> | undefined;
let userScrolled = false;
const lookAgainUsed = new Set<string>();

const req = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`panel shell is missing #${id}`);
  }
  return el as T;
};

const announceStatus = (key: string, subs?: string | string[]): void => {
  statusRegion.textContent = msg(key, subs);
};

const announceAlert = (key: string, subs?: string | string[]): void => {
  alertRegion.textContent = msg(key, subs);
};

const composedActiveElement = (): Element | null => {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
};

const isTyping = (): boolean => {
  const active = composedActiveElement();
  return (
    !!active &&
    (active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      (active as HTMLElement).isContentEditable)
  );
};

const focusResultHeading = (): void => {
  if (isTyping()) {
    return;
  }
  tripCard.focusHeading();
};

// Every result-slot swap runs through here so a swap that removes the
// focused subtree falls back to the persistent preview heading.
const swapResultSlot = (build: () => void): void => {
  const before = composedActiveElement();
  build();
  if (before && !before.isConnected) {
    previewHeading.focus({ preventScroll: true });
  }
};

const updatePreview = (srcUrl: string | null, kind: 'image' | 'frame' = 'image'): void => {
  previewFrame.replaceChildren();
  if (srcUrl && isAllowedPreviewUrl(srcUrl)) {
    const img = document.createElement('img');
    img.referrerPolicy = 'no-referrer';
    img.alt = msg(kind === 'frame' ? 'previewAltFrame' : 'previewAltImage');
    img.onerror = () => {
      showPreviewPlaceholder();
    };
    img.src = srcUrl;
    previewFrame.append(img);
  } else {
    showPreviewPlaceholder();
  }
};

const showPreviewPlaceholder = (): void => {
  previewFrame.replaceChildren();
  const text = document.createElement('span');
  text.textContent = msg('previewUnavailable');
  previewFrame.append(text);
};

const setPreviewIdentified = (placeName: string): void => {
  const img = previewFrame.querySelector('img');
  if (img) {
    img.alt = msg('previewAltIdentified', placeName);
  }
};

const clearContentSlots = (): void => {
  linksSlot.hidden = true;
  linksSlot.replaceChildren();
  guideSlot.hidden = true;
  searchLine.hidden = true;
  guideContent.replaceChildren();
  guideContent.removeAttribute('aria-busy');
  sourcesSlot.hidden = true;
  sourceChips.setSources([]);
  if (sourceChips.isConnected) {
    sourceChips.remove();
  }
};

const showLinks = (destination: string): void => {
  linksSlot.replaceChildren(bookingGrid);
  bookingGrid.setDestination(destination);
  linksSlot.hidden = false;
};

const showSources = (sources: GuideSource[]): void => {
  if (!sourceChips.isConnected) {
    sourcesSlot.append(sourceChips);
  }
  sourceChips.setSources(sources);
  sourcesSlot.hidden = sources.length === 0;
};

type PrivacyMode =
  | 'image'
  | 'image-only'
  | 'cache'
  | 'idle'
  | 'video-frame'
  | 'video-url'
  | 'board';

const updatePrivacy = (mode: PrivacyMode): void => {
  const keys: Record<PrivacyMode, string> = {
    image: 'privacyImage',
    'image-only': 'privacyImageOnly',
    cache: 'privacyCache',
    idle: 'privacyIdle',
    'video-frame': 'privacyVideoFrame',
    'video-url': 'privacyVideoUrl',
    board: 'privacyBoard',
  };
  privacyLine.textContent = msg(keys[mode]);
};

const clearCost = (): void => {
  costLine.textContent = '';
};

const priceAndRecord = async (provider: Provider): Promise<void> => {
  const usd = estimateCostUsd(runUsage, provider.getRates());
  if (usd === null) {
    costLine.textContent = msg('costLineTokens', [
      String(runUsage.inputTokens),
      String(runUsage.outputTokens),
    ]);
    return;
  }
  let monthTotal = usd;
  try {
    monthTotal = await recordMonthSpend(usd);
  } catch {
    // The run figure still renders; only the monthly total is stale.
  }
  costLine.textContent = msg('costLine', [formatUsd(usd), formatUsd(monthTotal)]);
};

const cancelSkeleton = (): void => {
  skeletonFor = '';
  if (skeletonTimer !== undefined) {
    clearTimeout(skeletonTimer);
    skeletonTimer = undefined;
  }
};

const showSkeleton = (id: string): void => {
  cancelSkeleton();
  skeletonFor = id;
  skeletonTimer = setTimeout(() => {
    if (skeletonFor !== id) {
      return;
    }
    swapResultSlot(() => {
      resultSlot.replaceChildren(tripCard);
      tripCard.setCard({ view: 'loading' });
    });
    currentView = 'loading';
    skeletonShownAt = Date.now();
  }, SKELETON_DELAY_MS);
};

const settleSkeleton = async (): Promise<void> => {
  cancelSkeleton();
  if (skeletonShownAt > 0) {
    const elapsed = Date.now() - skeletonShownAt;
    if (elapsed < SKELETON_MIN_MS) {
      await new Promise((resolve) => setTimeout(resolve, SKELETON_MIN_MS - elapsed));
    }
    skeletonShownAt = 0;
  }
};

const showIdle = (): void => {
  cancelSkeleton();
  currentView = 'idle';
  swapResultSlot(() => {
    resultSlot.replaceChildren(tripCard);
    tripCard.setCard({ view: 'idle', hint: msg('panelIdle'), shortcut: shortcutText });
  });
  clearContentSlots();
  updatePrivacy('idle');
  clearCost();
};

const showOnboarding = (orphaned: boolean): void => {
  cancelSkeleton();
  currentView = 'onboarding';
  clearContentSlots();
  swapResultSlot(() => {
    resultSlot.replaceChildren();
    if (orphaned) {
      const notice = document.createElement('p');
      notice.className = 'key-notice';
      notice.textContent = msg('keyReenterNotice');
      resultSlot.append(notice);
    }
    keySetup.showSetup();
    keySetup.setSessionOnly(runSettings?.sessionOnly ?? false);
    resultSlot.append(keySetup);
  });
  updatePrivacy('idle');
  clearCost();
};

const showConsent = (focusGate: boolean): void => {
  cancelSkeleton();
  currentView = 'consent';
  clearContentSlots();
  swapResultSlot(() => {
    resultSlot.replaceChildren(keySetup);
    keySetup.showConsent();
  });
  if (focusGate && !isTyping()) {
    keySetup.focusConsentHeading();
  }
};

// First-video gate: the same blocking inline-state pattern as consent
// (heading, disclosure, agree + explicit decline in DOM order), rendered in
// the light DOM because no key form is involved.
const showVideoConfirm = (rung2: boolean, focusGate: boolean): void => {
  cancelSkeleton();
  currentView = 'video-confirm';
  clearContentSlots();
  const heading = document.createElement('h2');
  heading.tabIndex = -1;
  heading.textContent = msg('videoConfirmTitle');
  const body = document.createElement('p');
  body.textContent = msg('videoConfirmBody');
  const actions = document.createElement('div');
  actions.className = 'confirm-actions';
  const agree = document.createElement('button');
  agree.type = 'button';
  agree.className = 'primary';
  agree.textContent = msg('videoConfirmAgree');
  agree.addEventListener('click', () => void onVideoConfirmAgree());
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = msg('videoConfirmCancel');
  cancel.addEventListener('click', () => onVideoConfirmCancel());
  actions.append(agree, cancel);
  const parts: HTMLElement[] = [heading, body];
  if (rung2) {
    const note = document.createElement('p');
    note.textContent = msg('videoConfirmRung2Note');
    parts.push(note);
  }
  parts.push(actions);
  swapResultSlot(() => {
    resultSlot.replaceChildren(...parts);
  });
  if (focusGate && !isTyping()) {
    heading.focus();
  }
};

const onVideoConfirmAgree = async (): Promise<void> => {
  await setVideoConsented();
  await resumePending();
};

const onVideoConfirmCancel = (): void => {
  pendingRun = null;
  analysisInFlight = false;
  updatePreview(null);
  showIdle();
  announceStatus('statusVideoConfirmDeclined');
};

const autoScrollGuide = (): void => {
  if (userScrolled || prefersReducedMotion()) {
    return;
  }
  if (typeof window.scrollTo === 'function') {
    window.scrollTo(0, document.body.scrollHeight);
  }
};

const onWindowScroll = (): void => {
  userScrolled =
    window.innerHeight + window.scrollY < document.body.scrollHeight - SCROLL_NEAR_BOTTOM_PX;
};

const abortActive = (): void => {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
};

const beginRun = (runId: string): void => {
  if (currentRunId !== runId) {
    currentRunId = runId;
    runUsage = emptyUsage();
  }
};

const clearStaleTimer = (): void => {
  if (staleTimer !== undefined) {
    clearTimeout(staleTimer);
    staleTimer = undefined;
  }
};

const wipeStoredRequest = async (requestId: string): Promise<void> => {
  try {
    const stored = (await chrome.storage.session.get('tripRequest')) as {
      tripRequest?: { requestId?: string };
    };
    if (stored.tripRequest?.requestId === requestId) {
      await chrome.storage.session.set({ tripRequest: { requestId, status: 'ready' } });
    }
  } catch {
    // Best-effort minimization; the data ages out with the session.
  }
};

const fallbackFor = (signals: PageSignals): { label: string; href: string } | null => {
  const best = [signals.jsonLd[0]?.name, signals.ogTitle, signals.alt, signals.docTitle].find(
    (candidate) => candidate && candidate.trim(),
  );
  if (!best) {
    return null;
  }
  const label = best.trim().slice(0, 80);
  return {
    label,
    href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label)}`,
  };
};

type RunOutcome = 'result' | 'no-place' | 'error' | 'aborted';

// Rung-2 media for a video request: only when no frame was captured, the URL
// is server-fetchable, and the provider speaks video. Centralized so re-runs
// (look again, re-analyze, retry) route exactly like the first attempt.
const videoUrlForRequest = (
  request: TripRequest,
  provider: Provider,
): string | undefined =>
  request.mediaType === 'video' &&
  !request.frame &&
  provider.capabilities.video &&
  isMp4RungUsable(request.srcUrl)
    ? request.srcUrl
    : undefined;

const privacyForRequest = (
  request: TripRequest,
  settings: ExtensionSettings,
  provider: Provider,
): PrivacyMode => {
  if (request.mediaType === 'video') {
    return videoUrlForRequest(request, provider) ? 'video-url' : 'video-frame';
  }
  return settings.imageOnly ? 'image-only' : 'image';
};

const isPlacePinned = async (place: PlaceResult): Promise<boolean> => {
  try {
    const pins = await listPins();
    const key = await dedupeKeyFor(place.placeName, place.country);
    for (const pin of pins) {
      if ((await dedupeKeyFor(pin.place.placeName, pin.place.country)) === key) {
        return true;
      }
    }
  } catch {
    // Fail closed: an unreadable board shows the unpinned state.
  }
  return false;
};

const renderResultHeader = async (place: PlaceResult, announce: boolean): Promise<void> => {
  await settleSkeleton();
  cancelSkeleton();
  currentView = 'result';
  const pinned = await isPlacePinned(place);
  swapResultSlot(() => {
    resultSlot.replaceChildren(tripCard);
    tripCard.setCard({
      view: 'result',
      place,
      lowConfidence: place.confidence < 0.6,
      pinned,
    });
  });
  showLinks(currentDestination);
  setPreviewIdentified(place.placeName);
  if (announce) {
    announceStatus('statusFoundWriting', place.placeName);
  }
};

const renderNoPlace = async (request: TripRequest, origin: 'gesture' | 'panel'): Promise<void> => {
  await settleSkeleton();
  cancelSkeleton();
  currentView = 'no-place';
  const signals = request.signals ?? EMPTY_SIGNALS;
  swapResultSlot(() => {
    resultSlot.replaceChildren(tripCard);
    tripCard.setCard({
      view: 'no-place',
      showLookAgain: !lookAgainUsed.has(currentCacheKey),
      fallback: fallbackFor(signals),
    });
  });
  clearContentSlots();
  announceStatus('statusNoPlace');
  if (origin === 'panel' && tripCard.isConnected) {
    focusResultHeading();
  }
};

const renderErrorCard = (
  titleKey: string,
  bodyKey: string,
  showRetry: boolean,
  withKeySetup: boolean,
  fallback: { label: string; href: string } | null = null,
): void => {
  cancelSkeleton();
  currentView = 'error';
  swapResultSlot(() => {
    resultSlot.replaceChildren(tripCard);
    tripCard.setCard({
      view: 'error',
      title: msg(titleKey),
      body: msg(bodyKey),
      showRetry,
      fallback,
    });
    if (withKeySetup) {
      keySetup.showSetup();
      keySetup.setSessionOnly(runSettings?.sessionOnly ?? false);
      resultSlot.append(keySetup);
    }
  });
};

// Error-path footer: video runs report their rung (a frame-carrying request
// ran rung 1, a frameless one ran rung 2), everything else keeps the old rule.
const errorPrivacy = (request: TripRequest | null): PrivacyMode => {
  if (request?.mediaType === 'video') {
    return request.frame ? 'video-frame' : 'video-url';
  }
  return 'image';
};

const showProviderError = (
  err: unknown,
  request: TripRequest | null,
  privacyOverride?: PrivacyMode,
): void => {
  const privacy = privacyOverride ?? errorPrivacy(request);
  if (!(err instanceof ProviderError)) {
    renderErrorCard('errorServerTitle', 'errorServerBody', true, false);
    announceAlert('alertServer');
    updatePrivacy(privacy);
    return;
  }
  if (err.code === 'aborted') {
    return;
  }
  if (err.code === 'consent_required') {
    pendingRun = request ? { kind: 'request', request } : pendingRun;
    showConsent(false);
    announceStatus('statusConsentNeeded');
    return;
  }
  if (err.code === 'no_key') {
    pendingRun = request ? { kind: 'request', request } : pendingRun;
    showOnboarding(false);
    announceStatus('statusKeyNeeded');
    return;
  }
  if (err.code === 'auth') {
    pendingRun = request != null ? { kind: 'request', request } : pendingRun;
    renderErrorCard('errorAuthTitle', 'errorAuthBody', false, true);
    announceAlert('alertAuth');
    updatePrivacy(privacy);
    return;
  }
  const titles: Record<string, [string, string, string]> = {
    rate_limited: ['errorRateTitle', 'errorRateBody', 'alertRateLimited'],
    server: ['errorServerTitle', 'errorServerBody', 'alertServer'],
    network: ['errorNetworkTitle', 'errorNetworkBody', 'alertNetwork'],
    invalid_response: ['errorInvalidTitle', 'errorInvalidBody', 'alertInvalidResponse'],
    stream_error: ['errorStreamTitle', 'errorStreamBody', 'alertStreamError'],
    not_configured: ['errorServerTitle', 'alertNotConfigured', 'alertNotConfigured'],
  };
  const [titleKey, bodyKey, alertKey] = titles[err.code] ?? [
    'errorServerTitle',
    'errorServerBody',
    'alertServer',
  ];
  renderErrorCard(titleKey, bodyKey, true, false);
  announceAlert(alertKey);
  updatePrivacy(privacy);
};

const recordPartialUsage = (err: unknown, provider: Provider): void => {
  if (err instanceof ProviderError && err.usage) {
    runUsage = addUsage(runUsage, err.usage);
    void priceAndRecord(provider);
  }
};

interface StreamArgs {
  provider: Provider;
  key: string;
  destination: string;
  signal: AbortSignal;
  cacheKey: string | null;
  privacy: PrivacyMode;
  origin: 'gesture' | 'panel';
  prompt?: string;
  completeKey?: string;
}

const streamGuideRun = async (args: StreamArgs): Promise<RunOutcome> => {
  const { provider, key, destination, signal, cacheKey, privacy, origin } = args;
  const renderer = createGuideRenderer(guideContent, msg('truncatedNotice'));
  guideSlot.hidden = false;
  userScrolled = false;
  guideContent.setAttribute('aria-busy', 'true');
  let guideSource = '';
  const sources: GuideSource[] = [];
  let searchedWeb = false;
  let guideStarted = false;
  try {
    const events = provider.streamGuide(key, {
      destination,
      signal,
      language: chrome.i18n.getUILanguage(),
      prompt: args.prompt,
    });
    for await (const event of events) {
      if (event.type === 'delta') {
        guideSource += event.text;
        if (!guideStarted) {
          const start = findGuideStart(guideSource);
          if (start >= 0) {
            guideStarted = true;
            renderer.push(guideSource.slice(start));
            autoScrollGuide();
          }
        } else {
          renderer.push(event.text);
          autoScrollGuide();
        }
      } else if (event.type === 'searching') {
        searchedWeb = true;
        searchLine.textContent = msg('statusSearchingWeb');
        searchLine.hidden = false;
        announceStatus('statusSearchingWeb');
      } else if (event.type === 'sources') {
        sources.push(...event.sources);
        currentSources = [...sources];
        showSources(sources);
      } else if (event.type === 'usage') {
        runUsage = addUsage(runUsage, event.usage);
      }
    }
  } catch (err) {
    guideContent.removeAttribute('aria-busy');
    searchLine.hidden = true;
    resultSlot.removeAttribute('aria-busy');
    if (err instanceof ProviderError && err.code === 'aborted') {
      return 'aborted';
    }
    const notice = document.createElement('p');
    notice.className = 'guide-interrupted';
    notice.textContent = msg('guideInterrupted');
    guideContent.append(notice);
    recordPartialUsage(err, provider);
    showProviderError(err, activeRequest, privacy);
    analysisInFlight = false;
    return 'error';
  }
  if (!guideStarted) {
    // Degenerate stream with no heading: render everything rather than
    // dropping content the hold-back rule cannot place.
    renderer.push(guideSource);
  } else {
    guideSource = guideSource.slice(findGuideStart(guideSource));
  }
  renderer.finish();
  guideContent.removeAttribute('aria-busy');
  searchLine.hidden = true;
  resultSlot.removeAttribute('aria-busy');
  if (cacheKey && currentPlace) {
    await setCacheEntry(cacheKey, {
      place: currentPlace,
      guide: guideSource,
      sources: [...sources],
      usage: { ...runUsage },
      searchedWeb,
    });
  }
  await priceAndRecord(provider);
  updatePrivacy(privacy);
  if (args.completeKey) {
    announceStatus(args.completeKey);
  } else if (sources.length > 0) {
    announceStatus('statusGuideReadySources', String(sources.length));
  } else {
    announceStatus('statusGuideReady');
  }
  if (origin === 'panel') {
    focusResultHeading();
  }
  analysisInFlight = false;
  return 'result';
};

interface IdentifyArgs {
  request: TripRequest;
  provider: Provider;
  settings: ExtensionSettings;
  key: string;
  origin: 'gesture' | 'panel';
  insist: boolean;
  rejectedPlace?: string;
}

const identifyAndGuide = async (args: IdentifyArgs): Promise<RunOutcome> => {
  const { request, provider, settings, key, origin, insist, rejectedPlace } = args;
  activeProvider = provider;
  const controller = new AbortController();
  activeController = controller;
  const signal = controller.signal;
  const finishController = (): void => {
    if (activeController === controller) {
      activeController = null;
    }
  };
  const signals = request.signals ?? EMPTY_SIGNALS;
  const signalsText = formatSignalsForPrompt(signals, settings.imageOnly);
  const privacy = privacyForRequest(request, settings, provider);
  let identify;
  try {
    identify = await provider.identifyPlace(key, {
      imageUrl: request.frame?.dataUrl ?? request.srcUrl,
      signalsText,
      signal,
      insist,
      rejectedPlace,
      videoUrl: videoUrlForRequest(request, provider),
    });
  } catch (err) {
    finishController();
    if (err instanceof ProviderError && err.code === 'aborted') {
      return 'aborted';
    }
    recordPartialUsage(err, provider);
    showProviderError(err, request);
    analysisInFlight = false;
    return 'error';
  }
  runUsage = addUsage(runUsage, identify.usage);
  currentPlace = identify.place;
  await wipeStoredRequest(request.requestId);
  await setCacheEntry(currentCacheKey, {
    place: identify.place,
    guide: '',
    sources: [],
    usage: { ...runUsage },
    searchedWeb: false,
  });
  if (!identify.place.identified) {
    finishController();
    await renderNoPlace(request, origin);
    await priceAndRecord(provider);
    updatePrivacy(privacy);
    analysisInFlight = false;
    return 'no-place';
  }
  const destination = buildDestination(
    identify.place.placeName,
    identify.place.city,
    identify.place.country,
  );
  currentDestination = destination;
  currentSources = [];
  await renderResultHeader(identify.place, true);
  const outcome = await streamGuideRun({
    provider,
    key,
    destination,
    signal,
    cacheKey: currentCacheKey,
    privacy,
    origin,
  });
  finishController();
  return outcome;
};

const renderCached = async (entry: CacheEntry, origin: 'gesture' | 'panel'): Promise<void> => {
  cancelSkeleton();
  currentPlace = entry.place;
  currentSources = [...entry.sources];
  if (!entry.place.identified) {
    currentView = 'no-place';
    swapResultSlot(() => {
      resultSlot.replaceChildren(tripCard);
      tripCard.setCard({
        view: 'no-place',
        showLookAgain: !lookAgainUsed.has(currentCacheKey),
        fallback: activeRequest ? fallbackFor(activeRequest.signals ?? EMPTY_SIGNALS) : null,
      });
    });
    clearContentSlots();
    costLine.textContent = msg('costLineCache');
    updatePrivacy('cache');
    announceStatus('statusNoPlace');
    if (origin === 'panel') {
      focusResultHeading();
    }
    return;
  }
  currentDestination = buildDestination(
    entry.place.placeName,
    entry.place.city,
    entry.place.country,
  );
  currentView = 'result';
  const pinned = await isPlacePinned(entry.place);
  swapResultSlot(() => {
    resultSlot.replaceChildren(tripCard);
    tripCard.setCard({
      view: 'result',
      place: entry.place,
      lowConfidence: entry.place.confidence < 0.6,
      pinned,
    });
  });
  showLinks(currentDestination);
  const renderer = createGuideRenderer(guideContent, msg('truncatedNotice'));
  guideSlot.hidden = false;
  renderer.push(entry.guide);
  renderer.finish();
  if (entry.sources.length > 0) {
    showSources(entry.sources);
  } else {
    sourcesSlot.hidden = true;
  }
  setPreviewIdentified(entry.place.placeName);
  costLine.textContent = msg('costLineCache');
  updatePrivacy('cache');
  announceStatus('statusCacheHit', entry.place.placeName);
  if (origin === 'panel') {
    focusResultHeading();
  }
};

type VideoRoute =
  | { kind: 'frame' }
  | { kind: 'rung2' }
  | { kind: 'error'; titleKey: string; bodyKey: string };

const routeVideoRequest = (request: TripRequest, provider: Provider): VideoRoute => {
  if (request.frame) {
    return { kind: 'frame' };
  }
  if (request.frameError === 'drm') {
    return { kind: 'error', titleKey: 'errorVideoTitle', bodyKey: 'errorVideoBody' };
  }
  if (isMp4RungUsable(request.srcUrl)) {
    if (provider.capabilities.video) {
      return { kind: 'rung2' };
    }
    return { kind: 'error', titleKey: 'errorVideoTitle', bodyKey: 'errorVideoProviderBody' };
  }
  if (request.frameError === 'no-match') {
    return { kind: 'error', titleKey: 'errorVideoMatchTitle', bodyKey: 'errorVideoMatchBody' };
  }
  return { kind: 'error', titleKey: 'errorVideoTitle', bodyKey: 'errorVideoBody' };
};

const runVideoAnalysis = async (
  request: TripRequest,
  provider: Provider,
  settings: ExtensionSettings,
  key: string,
  origin: 'gesture' | 'panel',
  superseded: boolean,
): Promise<void> => {
  const route = routeVideoRequest(request, provider);
  if (route.kind === 'error') {
    analysisInFlight = false;
    updatePreview(null);
    renderErrorCard(
      route.titleKey,
      route.bodyKey,
      false,
      false,
      fallbackFor(request.signals ?? EMPTY_SIGNALS),
    );
    announceAlert('alertVideoUnreadable');
    updatePrivacy('idle');
    return;
  }
  if (!(await hasVideoConsented())) {
    analysisInFlight = false;
    pendingRun = { kind: 'request', request };
    updatePreview(request.frame?.dataUrl ?? null, request.frame ? 'frame' : 'image');
    showVideoConfirm(route.kind === 'rung2', origin === 'panel');
    announceStatus('statusVideoConfirmNeeded');
    return;
  }
  if (route.kind === 'frame' && request.frame) {
    updatePreview(request.frame.dataUrl, 'frame');
    currentCacheKey = await hashCacheKey(
      frameCacheSeed(request.frame.time),
      request.pageUrl ?? '',
    );
  } else {
    updatePreview(null);
    currentCacheKey = await hashCacheKey(request.srcUrl, request.pageUrl ?? '');
  }
  const cached = await getCacheEntry(currentCacheKey);
  if (cached) {
    analysisInFlight = false;
    activeController = null;
    await renderCached(cached, origin);
    return;
  }
  announceStatus(
    superseded ? 'statusCanceledNew' : route.kind === 'frame' ? 'statusAnalyzingFrame' : 'statusAnalyzingVideo',
  );
  showSkeleton(request.requestId);
  await identifyAndGuide({
    request,
    provider,
    settings,
    key,
    origin,
    insist: false,
  });
};

const runAnalysis = async (request: TripRequest, origin: 'gesture' | 'panel'): Promise<void> => {
  abortActive();
  clearStaleTimer();
  const superseded = analysisInFlight;
  analysisInFlight = true;
  beginRun(request.requestId);
  activeRequest = request;
  lastRun = { kind: 'request', request };
  pendingRun = null;
  updatePreview(request.srcUrl || null);
  clearCost();
  const { provider, settings } = await getActiveProvider();
  activeProvider = provider;
  runSettings = settings;
  const keyStatus = await loadKey(provider.id);
  if (keyStatus.state !== 'ok') {
    analysisInFlight = false;
    pendingRun = { kind: 'request', request };
    showOnboarding(keyStatus.orphaned);
    announceStatus('statusKeyNeeded');
    return;
  }
  if (!(await hasConsented())) {
    analysisInFlight = false;
    pendingRun = { kind: 'request', request };
    showConsent(false);
    announceStatus('statusConsentNeeded');
    return;
  }
  if (request.mediaType === 'video') {
    await runVideoAnalysis(request, provider, settings, keyStatus.key, origin, superseded);
    return;
  }
  if (request.dataPending || !request.srcUrl) {
    analysisInFlight = false;
    renderErrorCard('errorDataTitle', 'errorDataBody', false, false);
    announceAlert('errorDataBody');
    updatePrivacy('idle');
    return;
  }
  currentCacheKey = await hashCacheKey(request.srcUrl, request.pageUrl ?? '');
  const cached = await getCacheEntry(currentCacheKey);
  if (cached) {
    analysisInFlight = false;
    activeController = null;
    await renderCached(cached, origin);
    return;
  }
  announceStatus(superseded ? 'statusCanceledNew' : 'statusAnalyzing');
  showSkeleton(request.requestId);
  await identifyAndGuide({
    request,
    provider,
    settings,
    key: keyStatus.key,
    origin,
    insist: false,
  });
};

const handle = async (value: unknown): Promise<void> => {
  const probe = (value ?? {}) as { requestId?: unknown; srcUrl?: unknown };
  if (typeof probe.requestId === 'string' && typeof probe.srcUrl !== 'string') {
    return;
  }
  const parsed = TRIP_REQUEST_SCHEMA.safeParse(value);
  if (!parsed.success) {
    return;
  }
  const request = parsed.data;
  const rank = request.status === 'ready' ? 1 : 0;
  if (request.requestId < highestRequestId) {
    return;
  }
  if (request.requestId === highestRequestId && rank <= highestStatusRank) {
    return;
  }
  highestRequestId = request.requestId;
  highestStatusRank = rank;
  updatePreview(request.srcUrl || null);
  if (request.status === 'collecting') {
    announceStatus('statusAnalyzing');
    showSkeleton(request.requestId);
    clearStaleTimer();
    const id = request.requestId;
    staleTimer = setTimeout(() => {
      if (highestRequestId === id && highestStatusRank === 0) {
        highestStatusRank = -1;
        updatePreview(null);
        showIdle();
      }
    }, STALE_COLLECTING_MS);
    return;
  }
  await runAnalysis(request, 'gesture');
};

const lookAgain = async (): Promise<void> => {
  const request = activeRequest;
  if (!request?.srcUrl || !currentCacheKey || lookAgainUsed.has(currentCacheKey)) {
    return;
  }
  lookAgainUsed.add(currentCacheKey);
  analysisInFlight = true;
  resultSlot.setAttribute('aria-busy', 'true');
  announceStatus('statusAnalyzing');
  try {
    const { provider, settings } = await getActiveProvider();
    activeProvider = provider;
    runSettings = settings;
    const keyStatus = await loadKey(provider.id);
    if (keyStatus.state !== 'ok' || !(await hasConsented())) {
      pendingRun = { kind: 'request', request };
      if (keyStatus.state !== 'ok') {
        showOnboarding(keyStatus.orphaned);
        announceStatus('statusKeyNeeded');
      } else {
        showConsent(false);
        announceStatus('statusConsentNeeded');
      }
      analysisInFlight = false;
      return;
    }
    await identifyAndGuide({
      request,
      provider,
      settings,
      key: keyStatus.key,
      origin: 'panel',
      insist: true,
    });
  } finally {
    resultSlot.removeAttribute('aria-busy');
  }
};

const reanalyze = async (): Promise<void> => {
  const request = activeRequest;
  if (!request?.srcUrl || !currentPlace) {
    return;
  }
  analysisInFlight = true;
  resultSlot.setAttribute('aria-busy', 'true');
  announceStatus('statusAnalyzing');
  try {
    const { provider, settings } = await getActiveProvider();
    activeProvider = provider;
    runSettings = settings;
    const keyStatus = await loadKey(provider.id);
    if (keyStatus.state !== 'ok' || !(await hasConsented())) {
      pendingRun = { kind: 'request', request };
      if (keyStatus.state !== 'ok') {
        showOnboarding(keyStatus.orphaned);
        announceStatus('statusKeyNeeded');
      } else {
        showConsent(false);
        announceStatus('statusConsentNeeded');
      }
      analysisInFlight = false;
      return;
    }
    await identifyAndGuide({
      request,
      provider,
      settings,
      key: keyStatus.key,
      origin: 'panel',
      insist: false,
      rejectedPlace: currentPlace.placeName,
    });
  } finally {
    resultSlot.removeAttribute('aria-busy');
  }
};

const retry = async (): Promise<void> => {
  const target = lastRun;
  if (!target) {
    return;
  }
  clearContentSlots();
  if (target.kind === 'itinerary') {
    await planTrip();
  } else {
    await runAnalysis(target.request, 'panel');
  }
};

// ---- Trip Board (D1) ----

const pinDisplayName = (pin: BoardPin): string =>
  buildDestination(pin.place.placeName, pin.place.city, pin.place.country);

const boardItemViews = (pins: BoardPin[]): BoardItemView[] =>
  pins.map((pin) => ({
    placeName: pin.place.placeName,
    country: pin.place.country,
    title: pinDisplayName(pin),
    host: pin.sourceHost,
    image:
      pin.thumbnail ??
      (pin.imageUrl && isAllowedPreviewUrl(pin.imageUrl) ? pin.imageUrl : null),
  }));

const renderBoard = async (): Promise<BoardPin[]> => {
  const pins = await listPins();
  tripBoard.setBoard(boardItemViews(pins), pins.length >= 2);
  return pins;
};

const syncPinButton = async (): Promise<void> => {
  if (currentView !== 'result' || !currentPlace) {
    return;
  }
  tripCard.setCard({
    view: 'result',
    place: currentPlace,
    lowConfidence: currentPlace.confidence < 0.6,
    pinned: await isPlacePinned(currentPlace),
  });
};

const sourceHostFor = (request: TripRequest | null): string => {
  if (request?.pageUrl) {
    try {
      return new URL(request.pageUrl).host;
    } catch {
      // Fall through to the scraped host.
    }
  }
  return request?.signals?.pageHost ?? '';
};

const attemptPin = async (pin: Omit<BoardPin, 'addedAt'>, withoutThumb = false): Promise<void> => {
  const candidate = withoutThumb ? { ...pin, thumbnail: undefined } : pin;
  let outcome;
  try {
    outcome = await pinPlace(candidate);
  } catch {
    failedPin = pin;
    tripBoard.setNotice(msg('boardNoticePinFail', pin.place.placeName), true);
    announceAlert('alertPinFail', pin.place.placeName);
    return;
  }
  failedPin = null;
  tripBoard.setNotice(null, false);
  if (outcome.status === 'duplicate') {
    await syncPinButton();
    announceStatus('statusPinDuplicate', pin.place.placeName);
    return;
  }
  tripBoard.setBoard(boardItemViews(outcome.pins), outcome.pins.length >= 2);
  await syncPinButton();
  if (outcome.evicted) {
    announceStatus('statusPinnedEvicted', [pin.place.placeName, outcome.evicted.place.placeName]);
  } else {
    announceStatus('statusPinned', [pin.place.placeName, String(outcome.pins.length)]);
  }
};

const onPinToggle = async (): Promise<void> => {
  const place = currentPlace;
  if (!place || !place.identified) {
    return;
  }
  const frame = activeRequest?.frame?.dataUrl;
  const src = activeRequest?.srcUrl ?? '';
  const held = frame ?? (src.startsWith('data:image/') ? src : undefined);
  const thumbnail = held ? await makeThumbnail(held) : null;
  const pin: Omit<BoardPin, 'addedAt'> = {
    place,
    sourceHost: sourceHostFor(activeRequest),
    ...(thumbnail ? { thumbnail } : {}),
    ...(src && isAllowedPreviewUrl(src) && !src.startsWith('data:') ? { imageUrl: src } : {}),
  };
  await attemptPin(pin);
};

const onRemovePin = async (detail: TripRemovePinDetail): Promise<void> => {
  let pins: BoardPin[];
  try {
    pins = await removePin(detail.placeName, detail.country);
  } catch {
    failedRemove = detail;
    tripBoard.setNotice(msg('boardNoticeRemoveFail', detail.placeName), true);
    announceAlert('alertRemoveFail', detail.placeName);
    return;
  }
  failedRemove = null;
  tripBoard.setBoard(boardItemViews(pins), pins.length >= 2);
  await syncPinButton();
};

const onRetryPin = async (): Promise<void> => {
  if (failedPin) {
    const pin = failedPin;
    failedPin = null;
    await attemptPin(pin, true);
  } else if (failedRemove) {
    const target = failedRemove;
    failedRemove = null;
    await onRemovePin(target);
  }
};

const onClearConfirm = async (): Promise<void> => {
  try {
    await clearBoard();
  } catch {
    announceAlert('alertBoardClearFail');
    return;
  }
  tripBoard.setBoard([], false);
  await syncPinButton();
  tripBoard.focusHeading();
  announceStatus('boardCleared');
};

const narrationPrompt = (pins: BoardPin[], plan: ItineraryPlan): string => {
  const byName = new Map(pins.map((pin) => [pinDisplayName(pin), pin]));
  const displayName = (stop: string): string => {
    const pin = byName.get(stop);
    return pin ? pinDisplayName(pin) : stop;
  };
  let dayPlan: string;
  if (plan.days.length > 0) {
    dayPlan = plan.days
      .map(
        (day, index) =>
          `Day ${index + 1} - ${sanitizePromptHint(day.dayTitle, 80)}: ` +
          `${day.stopNames.map(displayName).join('; ')}. ` +
          sanitizePromptHint(day.summary, 500),
      )
      .join('\n');
  } else {
    const nights = new Map(plan.nightsEach.map((entry) => [entry.stop, entry.nights]));
    dayPlan = `Visit in order: ${plan.stops
      .map((stop) => `${displayName(stop)} (${nights.get(stop) ?? 1} nights)`)
      .join('; ')}. Split into sensible days yourself.`;
  }
  let prompt =
    `Narrate this trip itinerary day by day with a '## Day N: title' heading per day, ` +
    `4-6 highlight bullets across the trip, best months, and transport notes where relevant. ` +
    `Begin your answer immediately with the '## Day 1' heading: no preamble, no acknowledgement. Day plan:\n${dayPlan}`;
  const language = chrome.i18n.getUILanguage();
  if (language) {
    prompt += ` Write the narration in ${language}.`;
  }
  return prompt;
};

const renderItineraryCard = (pins: BoardPin[], plan: ItineraryPlan): void => {
  const byName = new Map(pins.map((pin) => [pinDisplayName(pin), pin]));
  const nights = new Map(plan.nightsEach.map((entry) => [entry.stop, entry.nights]));
  const stops = plan.stops.map((stop) => {
    const pin = byName.get(stop);
    const name = pin ? pinDisplayName(pin) : stop;
    return { name, nights: nights.get(stop) ?? null, links: buildLinks(name) };
  });
  currentView = 'itinerary';
  swapResultSlot(() => {
    resultSlot.replaceChildren(tripCard);
    tripCard.setCard({
      view: 'itinerary',
      title: msg('itineraryTitle', String(stops.length)),
      stops,
      mapsUrl: mapsDirUrl(stops.map((stop) => stop.name)),
      mapsLabel: msg('mapsLink', String(stops.length)),
    });
  });
};

const planTrip = async (): Promise<void> => {
  abortActive();
  clearStaleTimer();
  analysisInFlight = true;
  const itinId = `itinerary-${Date.now()}`;
  beginRun(itinId);
  lastRun = { kind: 'itinerary' };
  pendingRun = null;
  clearCost();
  const { provider, settings } = await getActiveProvider();
  activeProvider = provider;
  runSettings = settings;
  const keyStatus = await loadKey(provider.id);
  if (keyStatus.state !== 'ok') {
    analysisInFlight = false;
    pendingRun = { kind: 'itinerary' };
    showOnboarding(keyStatus.orphaned);
    announceStatus('statusKeyNeeded');
    return;
  }
  if (!(await hasConsented())) {
    analysisInFlight = false;
    pendingRun = { kind: 'itinerary' };
    showConsent(false);
    announceStatus('statusConsentNeeded');
    return;
  }
  const pins = await listPins();
  if (pins.length < 2) {
    // The Plan button guards this, but the board may have changed underneath.
    analysisInFlight = false;
    tripBoard.setBoard(boardItemViews(pins), false);
    return;
  }
  clearContentSlots();
  announceStatus('statusPlanning', String(pins.length));
  showSkeleton(itinId);
  const controller = new AbortController();
  activeController = controller;
  let result;
  try {
    result = await provider.planItinerary(keyStatus.key, {
      pins: pins.map((pin) => ({
        name: pinDisplayName(pin),
        host: pin.sourceHost,
        thumbnail: pin.thumbnail,
      })),
      signal: controller.signal,
    });
  } catch (err) {
    if (activeController === controller) {
      activeController = null;
    }
    if (err instanceof ProviderError && err.code === 'aborted') {
      return;
    }
    recordPartialUsage(err, provider);
    showProviderError(err, null, 'board');
    analysisInFlight = false;
    return;
  }
  runUsage = addUsage(runUsage, result.usage);
  await settleSkeleton();
  renderItineraryCard(pins, result.plan);
  updatePrivacy('board');
  focusResultHeading();
  await streamGuideRun({
    provider,
    key: keyStatus.key,
    destination: result.plan.stops.join(', '),
    signal: controller.signal,
    cacheKey: null,
    privacy: 'board',
    origin: 'panel',
    prompt: narrationPrompt(pins, result.plan),
    completeKey: 'statusItineraryReady',
  });
  if (activeController === controller) {
    activeController = null;
  }
};

const resumePending = async (): Promise<void> => {
  const pending = pendingRun;
  pendingRun = null;
  if (!pending) {
    showIdle();
    return;
  }
  if (pending.kind === 'itinerary') {
    await planTrip();
  } else {
    await runAnalysis(pending.request, 'panel');
  }
};

const onKeySave = async (detail: KeySaveRequestDetail): Promise<void> => {
  keySetup.setPending(true);
  announceStatus('statusValidatingKey');
  const { provider, settings } = await getActiveProvider();
  activeProvider = provider;
  runSettings = settings;
  try {
    await provider.testKey(detail.key);
  } catch (err) {
    keySetup.setPending(false);
    if (err instanceof ProviderError && err.code === 'auth') {
      keySetup.setError(msg('keyErrorRejected'));
    } else if (err instanceof ProviderError && err.code === 'network') {
      keySetup.setError(msg('keyErrorNetwork'));
    } else {
      keySetup.setError(msg('keyErrorRetry'));
    }
    return;
  }
  try {
    await saveKey(provider.id, detail.key, detail.sessionOnly);
    runSettings = { ...settings, sessionOnly: detail.sessionOnly };
    await saveSettings(runSettings);
  } catch {
    keySetup.setPending(false);
    keySetup.setError(msg('keyErrorRetry'));
    return;
  }
  keySetup.setPending(false);
  keySetup.clear();
  announceStatus('statusKeySaved');
  if (!(await hasConsented())) {
    showConsent(true);
    return;
  }
  await resumePending();
};

const onConsentDecision = async (detail: ConsentDecisionDetail): Promise<void> => {
  if (!detail.agreed) {
    pendingRun = null;
    analysisInFlight = false;
    updatePreview(null);
    showIdle();
    announceStatus('statusConsentDeclined');
    return;
  }
  await setConsented();
  await resumePending();
};

const onSessionOnlyChange = async (detail: SessionOnlyChangeDetail): Promise<void> => {
  try {
    const { provider, settings } = await getActiveProvider();
    runSettings = { ...settings, sessionOnly: detail.checked };
    await saveSettings(runSettings);
    const loaded = await loadKey(provider.id);
    if (loaded.state === 'ok') {
      await saveKey(provider.id, loaded.key, detail.checked);
    }
  } catch {
    // Best effort; the checkbox state stays as the user set it.
  }
};

const loadShortcutLine = async (): Promise<void> => {
  let text = msg('shortcutUnset');
  try {
    const commands = await chrome.commands.getAll();
    const action = commands.find((command) => command.name === '_execute_action');
    if (action?.shortcut) {
      text = msg('shortcutLine', action.shortcut);
    }
  } catch {
    // Keep the unset line.
  }
  shortcutText = text;
  if (currentView === 'idle') {
    tripCard.setCard({ view: 'idle', hint: msg('panelIdle'), shortcut: text });
  }
};

export const initPanel = (): void => {
  if (initialized) {
    return;
  }
  if (!document.getElementById('status-region')) {
    return;
  }
  initialized = true;
  adoptSharedStyles(document);
  pageTitle = req('page-title');
  previewHeading = req('preview-heading');
  previewFrame = req('preview-frame');
  statusRegion = req('status-region');
  alertRegion = req('alert-region');
  resultSlot = req('result-slot');
  linksSlot = req('links-slot');
  guideSlot = req('guide-slot');
  searchLine = req('search-line');
  guideContent = req('guide-content');
  sourcesSlot = req('sources-slot');
  sourcesHeading = req('sources-heading');
  boardSlot = req('board-slot');
  privacyLine = req('privacy-line');
  linksNoteSummary = req('links-note-summary');
  linksNoteBody = req('links-note-body');
  costLine = req('cost-line');

  document.title = msg('appName');
  document.documentElement.lang = msg('@@ui_locale').replace('_', '-');
  document.documentElement.dir = msg('@@bidi_dir');
  pageTitle.textContent = msg('appName');
  previewHeading.textContent = msg('previewHeading');
  sourcesHeading.textContent = msg('sourcesHeading');
  linksNoteSummary.textContent = msg('privacyLinksSummary');
  linksNoteBody.textContent = msg('privacyLinksBody');

  tripCard = document.createElement('trip-card') as TripCardElement;
  keySetup = document.createElement('key-setup') as KeySetupElement;
  bookingGrid = document.createElement('booking-grid') as BookingGridElement;
  sourceChips = document.createElement('source-chips') as SourceChipsElement;
  tripBoard = document.createElement('trip-board') as TripBoardElement;
  boardSlot.append(tripBoard);

  tripCard.addEventListener('trip-retry', () => {
    void retry();
  });
  tripCard.addEventListener('trip-look-again', () => {
    void lookAgain();
  });
  tripCard.addEventListener('trip-reanalyze', () => {
    void reanalyze();
  });
  tripCard.addEventListener('trip-pin', () => {
    void onPinToggle();
  });
  tripBoard.addEventListener('trip-remove-pin', (event) => {
    void onRemovePin((event as CustomEvent<TripRemovePinDetail>).detail);
  });
  tripBoard.addEventListener('trip-plan', () => {
    void planTrip();
  });
  tripBoard.addEventListener('trip-clear-confirm', () => {
    void onClearConfirm();
  });
  tripBoard.addEventListener('trip-retry-pin', () => {
    void onRetryPin();
  });
  keySetup.addEventListener('key-save-request', (event) => {
    void onKeySave((event as CustomEvent<KeySaveRequestDetail>).detail);
  });
  keySetup.addEventListener('consent-decision', (event) => {
    void onConsentDecision((event as CustomEvent<ConsentDecisionDetail>).detail);
  });
  keySetup.addEventListener('session-only-change', (event) => {
    void onSessionOnlyChange((event as CustomEvent<SessionOnlyChangeDetail>).detail);
  });
  window.addEventListener('scroll', onWindowScroll, { passive: true });

  updatePreview(null);
  showIdle();
  void loadShortcutLine();
  void renderBoard();

  chrome.storage.session.onChanged.addListener((changes) => {
    const change = changes['tripRequest'];
    if (change) {
      void handle(change.newValue);
    }
  });
  void chrome.storage.session.get('tripRequest').then((stored) => {
    const initial = (stored as { tripRequest?: unknown }).tripRequest;
    if (initial === undefined) {
      return;
    }
    void handle(initial);
  });
};

if (typeof document !== 'undefined') {
  initPanel();
}
