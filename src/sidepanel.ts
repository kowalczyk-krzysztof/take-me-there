// Panel state machine: handoff intake, key and consent gates, cached or live
// analysis with streamed guides, disagree flows, and the cost footer.
import './components/booking_grid';
import './components/compare_table';
import './components/key_setup';
import './components/scan_list';
import './components/source_chips';
import './components/trip_board';
import './components/trip_card';
import type { BookingGridElement } from './components/booking_grid';
import type { CompareTableElement } from './components/compare_table';
import type {
  ScanGuideDetail,
  ScanItemView,
  ScanListElement,
  ScanPinDetail,
  ScanPinSelectedDetail,
} from './components/scan_list';
import type {
  AlternatesView,
  CompareOptionView,
  TripAlternatesDetail,
  TripCompareDetail,
  TripPlanInsteadDetail,
} from './components/trip_card';
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
import { downscaleToJpegDataUrl, fetchImageBytes } from './image_fetch';
import { loadKey, saveKey, type KeyStatus } from './key_vault';
import {
  cropToSamBox,
  dataUrlToBytes,
  parseSamBoxes,
  selectSamBox,
  type SamPixelBox,
} from './sam';
import { estimateCostUsd, formatUsd, recordMonthSpend } from './pricing';
import { createGuideRenderer, findGuideStart } from './render_markdown';
import {
  TRIP_REQUEST_SCHEMA,
  type ItineraryPlan,
  type PageSignals,
  type PlaceAlternate,
  type PlaceResult,
  type ScannedImage,
  type ScannedPlace,
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
  downloadNanoModel,
  nanoAvailability,
  sanitizePromptHint,
  type AlternateIntent,
  type DuelSide,
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
  onDevice?: boolean;
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

type PendingRun =
  | { kind: 'request'; request: TripRequest }
  | { kind: 'scan-guide'; request: TripRequest; index: number }
  | { kind: 'itinerary' };

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
let scanList: ScanListElement;
let scanPlaces: ScannedPlace[] = [];
let scanThumbs: Array<string | null> = [];
let duelTable: CompareTableElement;
let currentCompareOptions: BoardPin[] = [];
let currentAlternates: { intent: AlternateIntent; alternatives: PlaceAlternate[] } | null = null;
let alternatesLoading: AlternateIntent | null = null;
let lastDuel: { a: DuelSide; b: DuelSide; aTitle: string; bTitle: string } | null = null;
let duelRunId = 0;
let alternatesRunId = 0;
let duelController: AbortController | null = null;
let alternatesController: AbortController | null = null;
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
let currentOnDevice = false;
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
  if (duelTable.isConnected) {
    duelTable.remove();
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
  | 'board'
  | 'names'
  | 'local-only';

const updatePrivacy = (mode: PrivacyMode): void => {
  const keys: Record<PrivacyMode, string> = {
    image: 'privacyImage',
    'image-only': 'privacyImageOnly',
    cache: 'privacyCache',
    idle: 'privacyIdle',
    'video-frame': 'privacyVideoFrame',
    'video-url': 'privacyVideoUrl',
    board: 'privacyBoard',
    names: 'privacyNames',
    'local-only': 'privacyLocal',
  };
  privacyLine.textContent = msg(keys[mode]);
};

const clearCost = (): void => {
  costLine.textContent = '';
};

const priceAndRecord = async (provider: Provider): Promise<void> => {
  const rates = provider.getRates();
  if (
    rates &&
    rates.inputUsdPerMTok === 0 &&
    rates.outputUsdPerMTok === 0 &&
    runUsage.flatFeesUsd === 0
  ) {
    costLine.textContent = msg('nanoFreeLine');
    return;
  }
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

// Scan chrome renders immediately (no trip-card delay): the collecting
// record already proved the harvest is underway.
const showScanSkeleton = (): void => {
  cancelSkeleton();
  clearContentSlots();
  currentView = 'scan';
  swapResultSlot(() => {
    resultSlot.replaceChildren(scanList);
    scanList.setLoading();
  });
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
  void refreshNanoSection(false);
};

// Milestone 3: the key form grows the on-device alternative wherever Nano
// could serve (onboarding, auth errors, eviction). Unavailable hardware
// keeps the plain "needs a Muse key" message.
const refreshNanoSection = async (instead: boolean): Promise<void> => {
  const state = await nanoAvailability();
  if (state === 'readily' || state === 'downloadable' || state === 'downloading') {
    keySetup.setNano(state === 'readily' ? 'ready' : 'downloadable', { instead });
  } else {
    keySetup.setNano('hidden');
  }
};

const runNanoDownload = async (onDone: () => Promise<void>): Promise<void> => {
  keySetup.setNano('downloading');
  announceStatus('nanoDownloadStart');
  let announcedMid = false;
  try {
    await downloadNanoModel((frac) => {
      keySetup.setNanoProgress(frac);
      if (!announcedMid && frac >= 0.5) {
        announcedMid = true;
        announceStatus('nanoDownloadMid');
      }
    });
  } catch {
    keySetup.setNano('failed');
    announceAlert('nanoDownloadFail');
    return;
  }
  announceStatus('nanoDownloadReady');
  const settings = await loadSettings();
  await saveSettings({ ...settings, preferOnDevice: true });
  await onDone();
};

const enableNanoAndResume = async (): Promise<void> => {
  const state = await nanoAvailability();
  if (state === 'unavailable') {
    keySetup.setNano('hidden');
    announceAlert('nanoUnavailable');
    return;
  }
  if (state === 'readily') {
    const settings = await loadSettings();
    await saveSettings({ ...settings, preferOnDevice: true });
    await resumePending();
    return;
  }
  await runNanoDownload(() => resumePending());
};

const showNanoDownload = (): void => {
  cancelSkeleton();
  currentView = 'nano';
  swapResultSlot(() => {
    resultSlot.replaceChildren(keySetup);
    keySetup.showSetup();
    keySetup.setSessionOnly(runSettings?.sessionOnly ?? false);
    keySetup.setNano('downloading');
  });
};

// "Try on-device instead" from a rate-limit or network error card: capable
// hardware downloads (with progress) or resumes immediately; anything else
// gets the honest unavailable announcement.
const tryNanoInstead = async (): Promise<void> => {
  const state = await nanoAvailability();
  if (state === 'unavailable') {
    announceAlert('nanoUnavailable');
    return;
  }
  if (state === 'readily') {
    const settings = await loadSettings();
    await saveSettings({ ...settings, preferOnDevice: true });
    await retry();
    return;
  }
  showNanoDownload();
  await runNanoDownload(() => retry());
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

// On-device runs carry no key: the provider ignores it, and neither the
// vault nor the Meta consent gate applies (nothing leaves the browser).
const runKey = (keyStatus: KeyStatus): string =>
  keyStatus.state === 'ok' ? keyStatus.key : '';

const abortActive = (): void => {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
  if (duelController) {
    duelController.abort();
    duelController = null;
  }
  if (alternatesController) {
    alternatesController.abort();
    alternatesController = null;
  }
  // Ready alternate cards survive (their indices stay valid); only the
  // in-flight marker resets, and the loser of a run race bows out by id.
  alternatesLoading = null;
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
  if (provider.capabilities.onDevice) {
    return 'local-only';
  }
  if (request.mediaType === 'video') {
    return videoUrlForRequest(request, provider) ? 'video-url' : 'video-frame';
  }
  return settings.imageOnly ? 'image-only' : 'image';
};

const auxPrivacy = (provider: Provider, mode: PrivacyMode): PrivacyMode =>
  provider.capabilities.onDevice ? 'local-only' : mode;

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
  currentAlternates = null;
  currentOnDevice = activeProvider?.capabilities.onDevice === true;
  const props = await resultCardProps(place);
  swapResultSlot(() => {
    resultSlot.replaceChildren(tripCard);
    tripCard.setCard(props);
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
  currentAlternates = null;
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
  showFetchRetry = false,
  showNanoInstead = false,
): void => {
  cancelSkeleton();
  currentView = 'error';
  currentAlternates = null;
  swapResultSlot(() => {
    resultSlot.replaceChildren(tripCard);
    tripCard.setCard({
      view: 'error',
      title: msg(titleKey),
      body: msg(bodyKey),
      showRetry,
      fallback,
      showFetchRetry,
      showNanoInstead,
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
  if (activeProvider?.capabilities.onDevice) {
    return 'local-only';
  }
  if (request?.mediaType === 'video') {
    return request.frame ? 'video-url' : 'video-frame';
  }
  return 'image';
};

const showProviderError = (
  err: unknown,
  request: TripRequest | null,
  privacyOverride?: PrivacyMode,
  fetchRetryAvailable = false,
): void => {
  const privacy = privacyOverride ?? errorPrivacy(request);
  // Milestone 2: a 400 on the image-bearing identify means the model could
  // not fetch the remote image, so the card offers the byte-fetch retry.
  const fetchRetry =
    fetchRetryAvailable &&
    err instanceof ProviderError &&
    err.status === 400 &&
    !!request &&
    !request.mediaType &&
    !request.scanImages &&
    !request.dataPending &&
    request.srcUrl.startsWith('https://');
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
    void refreshNanoSection(true);
    return;
  }
  if (err.code === 'not_configured') {
    // The on-device model was evicted (or the custom server was never
    // configured): the key form stays for the remote path, with the Nano
    // section as the re-enable loop.
    pendingRun = request != null ? { kind: 'request', request } : pendingRun;
    renderErrorCard('errorServerTitle', 'alertNotConfigured', true, true);
    announceAlert('alertNotConfigured');
    updatePrivacy(privacy);
    void refreshNanoSection(true);
    return;
  }
  const titles: Record<string, [string, string, string]> = {
    rate_limited: ['errorRateTitle', 'errorRateBody', 'alertRateLimited'],
    server: ['errorServerTitle', 'errorServerBody', 'alertServer'],
    network: ['errorNetworkTitle', 'errorNetworkBody', 'alertNetwork'],
    invalid_response: ['errorInvalidTitle', 'errorInvalidBody', 'alertInvalidResponse'],
    stream_error: ['errorStreamTitle', 'errorStreamBody', 'alertStreamError'],
  };
  const [titleKey, bodyKey, alertKey] = titles[err.code] ?? [
    'errorServerTitle',
    'errorServerBody',
    'alertServer',
  ];
  // Rate limits and network failures offer the on-device escape hatch; the
  // click probes availability, so an incapable device gets an honest
  // announcement instead of a download prompt.
  const nanoInstead = err.code === 'rate_limited' || err.code === 'network';
  renderErrorCard(titleKey, bodyKey, true, false, null, fetchRetry, nanoInstead);
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
      onDevice: provider.capabilities.onDevice === true ? true : undefined,
    });
  }
  await priceAndRecord(provider);
  updatePrivacy(privacy);
  if (args.completeKey) {
    announceStatus(args.completeKey);
  } else if (provider.capabilities.onDevice) {
    announceStatus('nanoGuideReady');
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
  rejectedPlace?: string;
}

// Guesses below this confidence render the no-place card instead of a
// guide: the model was told to guess rather than refuse, so the panel owns
// the refusal line. Tune against live traffic.
const NO_PLACE_MIN_CONFIDENCE = 0.35;

const identifyAndGuide = async (args: IdentifyArgs): Promise<RunOutcome> => {
  const { request, provider, settings, key, origin, rejectedPlace } = args;
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
      rejectedPlace,
      videoUrl: videoUrlForRequest(request, provider),
    });
  } catch (err) {
    finishController();
    if (err instanceof ProviderError && err.code === 'aborted') {
      return 'aborted';
    }
    recordPartialUsage(err, provider);
    showProviderError(
      err,
      request,
      undefined,
      !request.mediaType && !request.scanImages && !request.frame,
    );
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
  if (!identify.place.identified || identify.place.confidence < NO_PLACE_MIN_CONFIDENCE) {
    finishController();
    // Stash the guess: look-again rejects it to force a different candidate.
    currentPlace = identify.place;
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
  currentAlternates = null;
  currentOnDevice = entry.onDevice === true;
  const props = await resultCardProps(entry.place);
  swapResultSlot(() => {
    resultSlot.replaceChildren(tripCard);
    tripCard.setCard(props);
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
  });
};

// ---- Page scan (D2) ----

const scanPlaceResult = (place: ScannedPlace): PlaceResult => ({
  identified: true,
  placeName: place.placeName,
  city: place.city,
  country: place.country,
  confidence: place.confidence,
  oneLiner: '',
});

// Pair a scan guess with its harvest thumbnail. An out-of-range index or a
// non-previewable URL yields the placeholder, never a wrong image.
const pairScanThumb = (place: ScannedPlace, images: ScannedImage[]): string | null => {
  const index = place.imageIndex;
  if (!Number.isInteger(index) || index < 0 || index >= images.length) {
    return null;
  }
  const url = images[index]?.url ?? '';
  return url && isAllowedPreviewUrl(url) ? url : null;
};

const scanItemViews = async (places: ScannedPlace[], thumbs: Array<string | null>): Promise<ScanItemView[]> => {
  const views: ScanItemView[] = [];
  for (const [index, place] of places.entries()) {
    views.push({
      placeName: place.placeName,
      country: place.country,
      title: buildDestination(place.placeName, place.city, place.country),
      image: thumbs[index] ?? null,
      pinned: await isPlacePinned(scanPlaceResult(place)),
    });
  }
  return views;
};

const runScan = async (
  request: TripRequest,
  provider: Provider,
  settings: ExtensionSettings,
  key: string,
  origin: 'gesture' | 'panel',
): Promise<void> => {
  const images = request.scanImages ?? [];
  const privacy: PrivacyMode = auxPrivacy(provider, settings.imageOnly ? 'image-only' : 'image');
  if (images.length === 0) {
    analysisInFlight = false;
    renderErrorCard('scanEmptyTitle', 'scanEmptyBody', false, false);
    announceAlert('scanEmptyBody');
    updatePrivacy('idle');
    return;
  }
  showScanSkeleton();
  announceStatus('statusAnalyzing');
  const controller = new AbortController();
  activeController = controller;
  let result;
  try {
    result = await provider.scanPlaces(key, { images, signal: controller.signal });
  } catch (err) {
    if (activeController === controller) {
      activeController = null;
    }
    if (err instanceof ProviderError && err.code === 'aborted') {
      return;
    }
    recordPartialUsage(err, provider);
    showProviderError(err, request, privacy);
    analysisInFlight = false;
    return;
  }
  if (activeController === controller) {
    activeController = null;
  }
  runUsage = addUsage(runUsage, result.usage);
  await wipeStoredRequest(request.requestId);
  if (result.places.length === 0) {
    await priceAndRecord(provider);
    updatePrivacy(privacy);
    analysisInFlight = false;
    renderErrorCard('scanNoneTitle', 'scanNoneBody', false, false);
    announceAlert('scanNoneBody');
    return;
  }
  scanPlaces = result.places;
  scanThumbs = result.places.map((place) => pairScanThumb(place, images));
  const views = await scanItemViews(scanPlaces, scanThumbs);
  currentView = 'scan';
  swapResultSlot(() => {
    resultSlot.replaceChildren(scanList);
    scanList.setResults(views);
  });
  await priceAndRecord(provider);
  updatePrivacy(privacy);
  announceStatus('scanFound', String(scanPlaces.length));
  if (origin === 'panel') {
    scanList.focusHeading();
  }
  analysisInFlight = false;
};

const runScanGuide = async (
  request: TripRequest,
  index: number,
  origin: 'gesture' | 'panel',
): Promise<void> => {
  const place = scanPlaces[index];
  if (!place) {
    return;
  }
  abortActive();
  clearStaleTimer();
  analysisInFlight = true;
  beginRun(`${request.requestId}-guide-${index}`);
  activeRequest = request;
  lastRun = { kind: 'scan-guide', request, index };
  pendingRun = null;
  const result = scanPlaceResult(place);
  const thumb = scanThumbs[index] ?? null;
  updatePreview(thumb);
  clearCost();
  const { provider, settings } = await getActiveProvider();
  activeProvider = provider;
  runSettings = settings;
  const keyStatus = await loadKey(provider.id);
  if (!provider.capabilities.onDevice && keyStatus.state !== 'ok') {
    analysisInFlight = false;
    pendingRun = { kind: 'scan-guide', request, index };
    showOnboarding(keyStatus.orphaned);
    announceStatus('statusKeyNeeded');
    return;
  }
  if (!provider.capabilities.onDevice && !(await hasConsented())) {
    analysisInFlight = false;
    pendingRun = { kind: 'scan-guide', request, index };
    showConsent(false);
    announceStatus('statusConsentNeeded');
    return;
  }
  const privacy: PrivacyMode = auxPrivacy(provider, settings.imageOnly ? 'image-only' : 'image');
  currentCacheKey = await hashCacheKey(
    thumb ?? `scan:${result.placeName},${result.country}`,
    request.pageUrl ?? '',
  );
  const cached = await getCacheEntry(currentCacheKey);
  if (cached) {
    analysisInFlight = false;
    activeController = null;
    await renderCached(cached, origin);
    return;
  }
  // The scan already identified the place: stream the guide for the known
  // destination with no second identify pass.
  const destination = buildDestination(result.placeName, result.city, result.country);
  currentDestination = destination;
  currentSources = [];
  currentPlace = result;
  await setCacheEntry(currentCacheKey, {
    place: result,
    guide: '',
    sources: [],
    usage: { ...runUsage },
    searchedWeb: false,
  });
  await renderResultHeader(result, true);
  const controller = new AbortController();
  activeController = controller;
  await streamGuideRun({
    provider,
    key: runKey(keyStatus),
    destination,
    signal: controller.signal,
    cacheKey: currentCacheKey,
    privacy,
    origin,
  });
  if (activeController === controller) {
    activeController = null;
  }
};

const scanPinFor = (index: number): Omit<BoardPin, 'addedAt'> | null => {
  const place = scanPlaces[index];
  if (!place) {
    return null;
  }
  const thumb = scanThumbs[index] ?? null;
  return {
    place: scanPlaceResult(place),
    sourceHost: sourceHostFor(activeRequest),
    ...(thumb ? { imageUrl: thumb } : {}),
  };
};

const refreshScanPins = async (): Promise<void> => {
  if (currentView !== 'scan') {
    return;
  }
  scanList.setResults(await scanItemViews(scanPlaces, scanThumbs));
};

const onScanGuide = async (detail: ScanGuideDetail): Promise<void> => {
  const request = activeRequest;
  if (!request) {
    return;
  }
  await runScanGuide(request, detail.index, 'panel');
};

const onScanPin = async (detail: ScanPinDetail): Promise<void> => {
  const pin = scanPinFor(detail.index);
  if (!pin) {
    return;
  }
  await attemptPin(pin);
  await refreshScanPins();
};

const onScanPinSelected = async (detail: ScanPinSelectedDetail): Promise<void> => {
  for (const index of detail.indices) {
    const pin = scanPinFor(index);
    if (pin) {
      await attemptPin(pin);
    }
  }
  await refreshScanPins();
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
  if (!provider.capabilities.onDevice && keyStatus.state !== 'ok') {
    analysisInFlight = false;
    pendingRun = { kind: 'request', request };
    showOnboarding(keyStatus.orphaned);
    announceStatus('statusKeyNeeded');
    return;
  }
  if (!provider.capabilities.onDevice && !(await hasConsented())) {
    analysisInFlight = false;
    pendingRun = { kind: 'request', request };
    showConsent(false);
    announceStatus('statusConsentNeeded');
    return;
  }
  if (request.mediaType === 'video') {
    await runVideoAnalysis(request, provider, settings, runKey(keyStatus), origin, superseded);
    return;
  }
  if (request.scanImages !== undefined) {
    await runScan(request, provider, settings, runKey(keyStatus), origin);
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
    key: runKey(keyStatus),
    origin,
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
    if (request.scanImages !== undefined) {
      showScanSkeleton();
    } else {
      showSkeleton(request.requestId);
    }
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

// ---- SAM crop-to-landmark (Booster 3) ----

const SAM_OVERLAY_DWELL_MS = 1200;

interface SamCrop {
  dataUrl: string;
  box: SamPixelBox;
  width: number;
  height: number;
}

// Best-effort landmark crop for "look again": any failure (denied origin,
// undecodable bytes, SAM error, no valid box, superseding gesture) falls
// back to the full image. Never throws.
const trySamCrop = async (
  request: TripRequest,
  provider: Provider,
  key: string,
): Promise<SamCrop | null> => {
  try {
    return await samCropAttempt(request, provider, key);
  } catch {
    return null;
  }
};

const samCropAttempt = async (
  request: TripRequest,
  provider: Provider,
  key: string,
): Promise<SamCrop | null> => {
  const direct =
    request.frame?.dataUrl ??
    (request.srcUrl.startsWith('data:image/') ? request.srcUrl : null);
  let inputBytes = direct ? dataUrlToBytes(direct) : null;
  if (!inputBytes) {
    if (request.mediaType || request.scanImages || !request.srcUrl.startsWith('https://')) {
      return null;
    }
    let origin: string;
    try {
      origin = new URL(request.srcUrl).origin;
    } catch {
      return null;
    }
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    } catch {
      granted = false;
    }
    if (!granted) {
      return null;
    }
    try {
      inputBytes = await fetchImageBytes(request.srcUrl, new AbortController().signal);
    } catch {
      return null;
    } finally {
      try {
        await chrome.permissions.remove({ origins: [`${origin}/*`] });
      } catch {
        // The grant is already gone; nothing to clean up.
      }
    }
  }
  if (!inputBytes) {
    return null;
  }
  // One normalized bitmap feeds both the SAM call and the crop, so box
  // fractions always match the pixels being cut.
  let samDataUrl: string;
  try {
    samDataUrl = await downscaleToJpegDataUrl(inputBytes);
  } catch {
    return null;
  }
  const normBytes = dataUrlToBytes(samDataUrl);
  if (!normBytes) {
    return null;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([normBytes as BlobPart]));
  } catch {
    return null;
  }
  try {
    const segment = await provider.segmentLandmark(key, {
      imageDataUrl: samDataUrl,
      signal: new AbortController().signal,
    });
    runUsage = addUsage(runUsage, segment.usage);
    const box = selectSamBox(
      parseSamBoxes(segment.text),
      bitmap.width,
      bitmap.height,
    );
    if (!box || activeRequest !== request || highestRequestId !== request.requestId) {
      return null;
    }
    showSamOverlay(box, bitmap.width, bitmap.height);
    announceStatus('samZoomed');
    if (!prefersReducedMotion()) {
      await new Promise((resolve) => setTimeout(resolve, SAM_OVERLAY_DWELL_MS));
    }
    if (activeRequest !== request || highestRequestId !== request.requestId) {
      return null;
    }
    const dataUrl = await cropToSamBox(bitmap, box);
    showSamCrop(dataUrl);
    return { dataUrl, box, width: bitmap.width, height: bitmap.height };
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
};

// The overlay is a static box (no draw animation in either motion mode);
// reduced motion additionally skips the dwell and swaps instantly.
const showSamOverlay = (box: SamPixelBox, width: number, height: number): void => {
  const img = previewFrame.querySelector('img');
  if (!img) {
    return;
  }
  const frameRect = previewFrame.getBoundingClientRect();
  const imgRect = img.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.className = 'sam-box';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.left = `${imgRect.left - frameRect.left + (box.x1 / width) * imgRect.width}px`;
  overlay.style.top = `${imgRect.top - frameRect.top + (box.y1 / height) * imgRect.height}px`;
  overlay.style.width = `${((box.x2 - box.x1) / width) * imgRect.width}px`;
  overlay.style.height = `${((box.y2 - box.y1) / height) * imgRect.height}px`;
  previewFrame.append(overlay);
};

const showSamCrop = (dataUrl: string): void => {
  previewFrame.replaceChildren();
  const img = document.createElement('img');
  img.referrerPolicy = 'no-referrer';
  img.alt = msg('previewAltCrop');
  img.onerror = () => {
    showPreviewPlaceholder();
  };
  img.src = dataUrl;
  const caption = document.createElement('p');
  caption.className = 'preview-caption';
  caption.textContent = msg('samZoomCaption');
  previewFrame.append(img, caption);
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
    if (!provider.capabilities.onDevice && (keyStatus.state !== 'ok' || !(await hasConsented()))) {
      pendingRun = { kind: 'request', request };
      if (!provider.capabilities.onDevice && keyStatus.state !== 'ok') {
        showOnboarding(keyStatus.orphaned);
        announceStatus('statusKeyNeeded');
      } else {
        showConsent(false);
        announceStatus('statusConsentNeeded');
      }
      analysisInFlight = false;
      return;
    }
    let samCrop: SamCrop | null = null;
    if (provider.capabilities.segmentation) {
      samCrop = await trySamCrop(request, provider, runKey(keyStatus));
      if (activeRequest !== request || highestRequestId !== request.requestId) {
        return;
      }
    }
    const identifyRequest =
      samCrop && request.frame
        ? { ...request, frame: { ...request.frame, dataUrl: samCrop.dataUrl } }
        : samCrop
          ? { ...request, srcUrl: samCrop.dataUrl }
          : request;
    await identifyAndGuide({
      request: identifyRequest,
      provider,
      settings,
      key: runKey(keyStatus),
      origin: 'panel',
      rejectedPlace: currentPlace?.placeName || undefined,
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
    if (!provider.capabilities.onDevice && (keyStatus.state !== 'ok' || !(await hasConsented()))) {
      pendingRun = { kind: 'request', request };
      if (!provider.capabilities.onDevice && keyStatus.state !== 'ok') {
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
      key: runKey(keyStatus),
      origin: 'panel',
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
  } else if (target.kind === 'scan-guide') {
    await runScanGuide(target.request, target.index, 'panel');
  } else {
    await runAnalysis(target.request, 'panel');
  }
};

// Milestone 2: the model could not fetch the remote image, so the panel
// downloads the bytes itself (per-origin grant, credentials omitted) and
// retries with a data: URL. The grant is removed in the finally so it never
// outlives the click.
const fetchRetry = async (): Promise<void> => {
  const target =
    lastRun?.kind === 'request' ? lastRun.request : (
      activeRequest?.mediaType === undefined ? activeRequest : null
    );
  const srcUrl = target?.srcUrl ?? '';
  if (
    !target ||
    target.mediaType ||
    target.scanImages ||
    target.dataPending ||
    !srcUrl.startsWith('https://')
  ) {
    return;
  }
  let origin: string;
  try {
    origin = new URL(srcUrl).origin;
  } catch {
    return;
  }
  // Gesture rule: the permission prompt is the first await in this handler.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch {
    granted = false;
  }
  if (!granted) {
    announceAlert('fetchDenied');
    return;
  }
  try {
    abortActive();
    clearStaleTimer();
    announceStatus('statusAnalyzing');
    const controller = new AbortController();
    activeController = controller;
    let dataUrl: string;
    try {
      const bytes = await fetchImageBytes(srcUrl, controller.signal);
      dataUrl = await downscaleToJpegDataUrl(bytes);
    } catch {
      if (!controller.signal.aborted) {
        announceAlert('fetchFailed');
      }
      return;
    }
    if (controller.signal.aborted) {
      return;
    }
    await runAnalysis({ ...target, srcUrl: dataUrl, dataPending: false }, 'panel');
  } finally {
    try {
      await chrome.permissions.remove({ origins: [`${origin}/*`] });
    } catch {
      // The grant is already gone; nothing to clean up.
    }
  }
};

// ---- Destination duel (D3) + alternates (D4) ----

const FINDING_KEYS: Record<AlternateIntent, string> = {
  cheaper: 'alternatesFindingCheaper',
  quieter: 'alternatesFindingQuieter',
  similar: 'alternatesFindingSimilar',
};

const alternatesView = (): AlternatesView => {
  if (alternatesLoading) {
    return { state: 'loading', intent: alternatesLoading };
  }
  if (currentAlternates) {
    return {
      state: 'ready',
      intent: currentAlternates.intent,
      cards: currentAlternates.alternatives.map((alt) => ({
        name: buildDestination(alt.placeName, '', alt.country),
        why: alt.why,
        bestMonth: alt.bestMonth,
      })),
    };
  }
  return { state: 'idle' };
};

// Duel targets: every pin except the current result. Options are indexed
// (never name-keyed) so hostile pin text cannot collide or forge a target.
const compareOptionViews = async (place: PlaceResult): Promise<CompareOptionView[]> => {
  try {
    const pins = await listPins();
    const current = await dedupeKeyFor(place.placeName, place.country);
    currentCompareOptions = [];
    for (const pin of pins) {
      if ((await dedupeKeyFor(pin.place.placeName, pin.place.country)) === current) {
        continue;
      }
      currentCompareOptions.push(pin);
    }
  } catch {
    // Fail closed: an unreadable board hides the picker.
    currentCompareOptions = [];
  }
  return currentCompareOptions.map((pin, index) => ({
    value: String(index),
    label: pinDisplayName(pin),
  }));
};

const resultCardProps = async (
  place: PlaceResult,
): Promise<{
  view: 'result';
  place: PlaceResult;
  lowConfidence: boolean;
  pinned: boolean;
  onDevice: boolean;
  compareOptions: CompareOptionView[];
  alternates: AlternatesView;
}> => ({
  view: 'result',
  place,
  lowConfidence: place.confidence < 0.6,
  pinned: await isPlacePinned(place),
  onDevice: currentOnDevice,
  compareOptions: await compareOptionViews(place),
  alternates: alternatesView(),
});

const refreshResultCard = async (): Promise<void> => {
  if (currentView !== 'result' || !currentPlace) {
    return;
  }
  tripCard.setCard(await resultCardProps(currentPlace));
};

const runDuel = async (
  a: DuelSide,
  b: DuelSide,
  aTitle: string,
  bTitle: string,
): Promise<void> => {
  duelController?.abort();
  const controller = new AbortController();
  duelController = controller;
  duelRunId += 1;
  const mine = duelRunId;
  lastDuel = { a, b, aTitle, bTitle };
  const { provider, settings } = await getActiveProvider();
  activeProvider = provider;
  runSettings = settings;
  const keyStatus = await loadKey(provider.id);
  if (!provider.capabilities.onDevice && keyStatus.state !== 'ok') {
    announceStatus('statusKeyNeeded');
    return;
  }
  if (!provider.capabilities.onDevice && !(await hasConsented())) {
    announceStatus('statusConsentNeeded');
    return;
  }
  if (!duelTable.isConnected) {
    guideSlot.append(duelTable);
  }
  guideSlot.hidden = false;
  duelTable.setLoading(aTitle, bTitle);
  announceStatus('duelStatus', [a.name, b.name]);
  let result;
  try {
    result = await provider.duelPlaces(runKey(keyStatus), { a, b, signal: controller.signal });
  } catch (err) {
    if (duelController === controller) {
      duelController = null;
    }
    if (err instanceof ProviderError && err.code === 'aborted') {
      return;
    }
    if (mine !== duelRunId) {
      return;
    }
    recordPartialUsage(err, provider);
    updatePrivacy(auxPrivacy(provider, 'names'));
    duelTable.setError();
    if (err instanceof ProviderError && err.code === 'no_key') {
      announceAlert('statusKeyNeeded');
    } else if (err instanceof ProviderError && err.code === 'consent_required') {
      announceAlert('statusConsentNeeded');
    } else {
      announceAlert('duelError', [aTitle, bTitle]);
    }
    return;
  }
  if (duelController === controller) {
    duelController = null;
  }
  if (mine !== duelRunId) {
    return;
  }
  runUsage = addUsage(runUsage, result.usage);
  currentSources = [...result.sources];
  showSources(result.sources);
  duelTable.setResults(aTitle, bTitle, result.criteria, result.verdict);
  await priceAndRecord(provider);
  updatePrivacy(auxPrivacy(provider, 'names'));
  announceStatus('duelReady');
};

const onCompare = async (detail: TripCompareDetail): Promise<void> => {
  const snapshot = currentCompareOptions[Number(detail.value)];
  const current = currentPlace;
  // The picker snapshot re-verifies against the live board: a pin removed
  // since render (another tab, a race) misses and goes stale, never duels
  // the wrong target through a shifted index.
  let pin: BoardPin | undefined;
  if (snapshot) {
    try {
      const wanted = await dedupeKeyFor(snapshot.place.placeName, snapshot.place.country);
      const pins = await listPins();
      for (const candidate of pins) {
        if ((await dedupeKeyFor(candidate.place.placeName, candidate.place.country)) === wanted) {
          pin = candidate;
          break;
        }
      }
    } catch {
      pin = undefined;
    }
  }
  if (!current?.identified || !pin) {
    await refreshResultCard();
    announceStatus('compareStale');
    return;
  }
  await runDuel(
    { name: current.placeName, country: current.country },
    { name: pin.place.placeName, country: pin.place.country },
    buildDestination(current.placeName, current.city, current.country),
    pinDisplayName(pin),
  );
};

const onDuelRetry = async (): Promise<void> => {
  if (lastDuel) {
    await runDuel(lastDuel.a, lastDuel.b, lastDuel.aTitle, lastDuel.bTitle);
  }
};

const runAlternates = async (intent: AlternateIntent): Promise<void> => {
  const place = currentPlace;
  if (!place?.identified || currentView !== 'result') {
    return;
  }
  alternatesController?.abort();
  const controller = new AbortController();
  alternatesController = controller;
  alternatesRunId += 1;
  const mine = alternatesRunId;
  alternatesLoading = intent;
  currentAlternates = null;
  await refreshResultCard();
  announceStatus(FINDING_KEYS[intent]);
  const { provider, settings } = await getActiveProvider();
  activeProvider = provider;
  runSettings = settings;
  const keyStatus = await loadKey(provider.id);
  if (!provider.capabilities.onDevice && keyStatus.state !== 'ok') {
    if (mine !== alternatesRunId) {
      return;
    }
    alternatesLoading = null;
    await refreshResultCard();
    announceStatus('statusKeyNeeded');
    return;
  }
  if (!provider.capabilities.onDevice && !(await hasConsented())) {
    if (mine !== alternatesRunId) {
      return;
    }
    alternatesLoading = null;
    await refreshResultCard();
    announceStatus('statusConsentNeeded');
    return;
  }
  let result;
  try {
    result = await provider.findAlternates(runKey(keyStatus), {
      placeName: place.placeName,
      city: place.city,
      country: place.country,
      intent,
      signal: controller.signal,
    });
  } catch (err) {
    if (alternatesController === controller) {
      alternatesController = null;
    }
    if (err instanceof ProviderError && err.code === 'aborted') {
      return;
    }
    if (mine !== alternatesRunId) {
      return;
    }
    alternatesLoading = null;
    await refreshResultCard();
    recordPartialUsage(err, provider);
    updatePrivacy(auxPrivacy(provider, 'names'));
    announceAlert('alternatesFail');
    return;
  }
  if (alternatesController === controller) {
    alternatesController = null;
  }
  if (mine !== alternatesRunId) {
    return;
  }
  runUsage = addUsage(runUsage, result.usage);
  currentAlternates = { intent, alternatives: result.alternatives };
  alternatesLoading = null;
  await refreshResultCard();
  currentSources = [...result.sources];
  showSources(result.sources);
  await priceAndRecord(provider);
  updatePrivacy(auxPrivacy(provider, 'names'));
  announceStatus('alternatesReady', String(result.alternatives.length));
};

const onAlternates = async (detail: TripAlternatesDetail): Promise<void> => {
  await runAlternates(detail.intent);
};

const onPlanInstead = async (detail: TripPlanInsteadDetail): Promise<void> => {
  const target = currentAlternates?.alternatives[detail.index];
  if (!target || currentView !== 'result') {
    return;
  }
  // Model-produced destinations re-enter through the section-9 rule.
  const destination = sanitizePromptHint(buildDestination(target.placeName, '', target.country));
  if (!destination) {
    return;
  }
  const { provider, settings } = await getActiveProvider();
  activeProvider = provider;
  runSettings = settings;
  const keyStatus = await loadKey(provider.id);
  if (!provider.capabilities.onDevice && keyStatus.state !== 'ok') {
    announceStatus('statusKeyNeeded');
    return;
  }
  if (!provider.capabilities.onDevice && !(await hasConsented())) {
    announceStatus('statusConsentNeeded');
    return;
  }
  abortActive();
  clearStaleTimer();
  analysisInFlight = true;
  currentDestination = destination;
  currentSources = [];
  showSources([]);
  guideContent.replaceChildren();
  showLinks(destination);
  announceStatus('statusAnalyzing');
  const controller = new AbortController();
  activeController = controller;
  await streamGuideRun({
    provider,
    key: runKey(keyStatus),
    destination,
    signal: controller.signal,
    cacheKey: null,
    privacy: auxPrivacy(provider, 'names'),
    origin: 'panel',
  });
  if (activeController === controller) {
    activeController = null;
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
  // Pin state and duel targets refresh together: every board write lands
  // here, so the compare picker never goes stale behind the card.
  await refreshResultCard();
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
  if (!provider.capabilities.onDevice && keyStatus.state !== 'ok') {
    analysisInFlight = false;
    pendingRun = { kind: 'itinerary' };
    showOnboarding(keyStatus.orphaned);
    announceStatus('statusKeyNeeded');
    return;
  }
  if (!provider.capabilities.onDevice && !(await hasConsented())) {
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
    result = await provider.planItinerary(runKey(keyStatus), {
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
  updatePrivacy(auxPrivacy(provider, 'board'));
  focusResultHeading();
  await streamGuideRun({
    provider,
    key: runKey(keyStatus),
    destination: result.plan.stops.join(', '),
    signal: controller.signal,
    cacheKey: null,
    privacy: auxPrivacy(provider, 'board'),
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
  } else if (pending.kind === 'scan-guide') {
    await runScanGuide(pending.request, pending.index, 'panel');
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
  if (!provider.capabilities.onDevice && !(await hasConsented())) {
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
  scanList = document.createElement('scan-list') as ScanListElement;
  duelTable = document.createElement('compare-table') as CompareTableElement;
  keySetup = document.createElement('key-setup') as KeySetupElement;
  bookingGrid = document.createElement('booking-grid') as BookingGridElement;
  sourceChips = document.createElement('source-chips') as SourceChipsElement;
  tripBoard = document.createElement('trip-board') as TripBoardElement;
  boardSlot.append(tripBoard);

  tripCard.addEventListener('trip-retry', () => {
    void retry();
  });
  tripCard.addEventListener('trip-fetch-retry', () => {
    void fetchRetry();
  });
  tripCard.addEventListener('trip-nano', () => {
    void tryNanoInstead();
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
  tripCard.addEventListener('trip-compare', (event) => {
    void onCompare((event as CustomEvent<TripCompareDetail>).detail);
  });
  tripCard.addEventListener('trip-alternates', (event) => {
    void onAlternates((event as CustomEvent<TripAlternatesDetail>).detail);
  });
  tripCard.addEventListener('trip-plan-instead', (event) => {
    void onPlanInstead((event as CustomEvent<TripPlanInsteadDetail>).detail);
  });
  duelTable.addEventListener('duel-retry', () => {
    void onDuelRetry();
  });
  scanList.addEventListener('scan-guide', (event) => {
    void onScanGuide((event as CustomEvent<ScanGuideDetail>).detail);
  });
  scanList.addEventListener('scan-pin', (event) => {
    void onScanPin((event as CustomEvent<ScanPinDetail>).detail);
  });
  scanList.addEventListener('scan-pin-selected', (event) => {
    void onScanPinSelected((event as CustomEvent<ScanPinSelectedDetail>).detail);
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
  keySetup.addEventListener('nano-enable', () => {
    void enableNanoAndResume();
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
