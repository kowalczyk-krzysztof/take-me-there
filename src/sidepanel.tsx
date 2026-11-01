// Panel state machine: handoff intake, key and consent gates, cached or live
// analysis, disagree flows, and the cost footer.
import { useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BookingGrid } from './components/booking_grid/booking_grid';
import type { AlternatesView, CardState, ConfidenceView } from './components/trip_card/trip_card';
import { TripCard } from './components/trip_card/trip_card';
import { KeySetup } from './components/key_setup/key_setup';
import type { LoadingPhase } from './components/trip_card/trip_card';
import { ModesSection } from './components/settings/modes_section';
import { CostSection } from './components/settings/cost_section';
import { attachSettingsInputs, setMode } from './settings_ops';
import { prefersReducedMotion } from './utils/dom';
import { buildDestination } from './deep_links';
import {
  dataUrlToBytes,
  downscaleToJpegDataUrl,
  fetchImageBytes,
  fetchImageBytesViaTab,
} from './image_fetch';
import { clearKey, isVaultKey, loadKey, saveKey, setKeyMode } from './key_vault';
import { cropToSamBox, parseSamBoxes, selectSamBox, type SamPixelBox } from './sam';
import { estimateCostUsd, formatUsd, readMonthSpend } from './pricing';
import {
  TRIP_REQUEST_SCHEMA,
  type PageSignals,
  type PlaceAlternate,
  type PlaceResult,
  type TripRequest,
} from './types';
import { frameCacheSeed, hasVideoConsented, isRung2Usable, setVideoConsented } from './video';
import { HANDOFF_TTL_MS, ackRequest, handoffSlotKey } from './handoff';
import { withTempGrant } from './grants';
import {
  absorbRunUsage,
  activeRun,
  cancelActiveRun,
  createEphemeralRun,
  markDisplayed,
  ownsUi,
  settleStage,
  startRun,
  type RunContext,
} from './run_state';
import {
  ProviderError,
  formatSignalsForPrompt,
  getActiveProvider,
  hasConsented,
  loadSettings,
  saveSettings,
  setConsented,
  SETTINGS_STORAGE_KEY,
  type AlternateIntent,
  type ExtensionSettings,
  type Provider,
  type Usage,
} from './providers/index';
import {
  getCacheEntry,
  hashIdentifyKey,
  isAllowedPreviewUrl,
  setCacheEntry,
  type CacheEntry,
} from './result_cache';
import { ErrorBoundary } from './components/error_boundary/error_boundary';
import { msg } from './utils/i18n';
import { truncateCodePoints } from './utils/text';
import { createStore } from './utils/store';
import './styles/sidepanel.css';
import './components/shared_styles.css';

const SKELETON_DELAY_MS = 200;

const SKELETON_MIN_MS = 300;

const STALE_COLLECTING_MS = 5000;

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

type PendingRun = { kind: 'request'; request: TripRequest };

let initialized = false;

let currentAlternates: { intent: AlternateIntent; alternatives: PlaceAlternate[] } | null = null;

let alternatesLoading: AlternateIntent | null = null;

let alternatesRunId = 0;

let alternatesController: AbortController | null = null;

interface PreviewOverlay {
  left: number;
  top: number;
  width: number;
  height: number;
}

type PreviewState =
  | { kind: 'placeholder' }
  | {
      kind: 'image';
      src: string;
      frame: boolean;
      identified: string | null;
      overlay: PreviewOverlay | null;
    }
  | { kind: 'crop'; src: string; identified: string | null };

interface ResultSlotState {
  card: CardState | null;
  consent: boolean;
  video: { rung2: boolean; imageOnly: boolean } | null;
}

interface KeyFormState {
  pending: boolean;
  error: string | null;
  sessionOnly: boolean;
  resetKey: number;
}

interface PanelSettingsState {
  loaded: boolean;
  imageOnly: boolean;
  skipWebSearch: boolean;
  costText: string;
}

interface PanelState {
  tab: 'main' | 'settings';
  panelSettings: PanelSettingsState;
  keySaved: boolean;
  replacing: boolean;
  showOrphaned: boolean;
  status: string;
  statusSeq: number;
  alert: string;
  alertSeq: number;
  preview: PreviewState;
  result: ResultSlotState;
  resultBusy: boolean;
  links: string | null;
  privacy: string;
  cost: string;
  keyForm: KeyFormState;
}

const blankResultSlot = (): ResultSlotState => ({
  card: null,
  consent: false,
  video: null,
});

const store = createStore<PanelState>({
  tab: 'main',
  panelSettings: {
    loaded: false,
    imageOnly: false,
    skipWebSearch: false,
    costText: '',
  },
  keySaved: false,
  replacing: false,
  showOrphaned: false,
  status: '',
  statusSeq: 0,
  alert: '',
  alertSeq: 0,
  preview: { kind: 'placeholder' },
  result: blankResultSlot(),
  resultBusy: false,
  links: null,
  privacy: '',
  cost: '',
  keyForm: {
    pending: false,
    error: null,
    sessionOnly: false,
    resetKey: 0,
  },
});

type PanelTab = 'main' | 'settings';

const TAB_IDS: Record<PanelTab, string> = {
  main: 'tab-main',
  settings: 'tab-settings',
};

const selectTab = (tab: PanelTab): void => {
  const state = store.get();

  if (tab === state.tab) {
    return;
  }
  store.set({ tab });

  if (tab === 'settings') {
    void refreshPanelSettings();
  }

  const active = document.activeElement as HTMLElement | null;

  const panel = active?.closest('#main-panel, #settings-panel');

  if (panel?.hasAttribute('hidden')) {
    document.getElementById(TAB_IDS[tab])?.focus();
  }
};

const enabledTabs = (): PanelTab[] => ['main', 'settings'];

let lockEpoch = 0;

const refreshLock = async (): Promise<void> => {
  const epoch = ++lockEpoch;

  try {
    const { provider } = await getActiveProvider();

    const keyStatus = await loadKey(provider.id);

    if (epoch !== lockEpoch) {
      return;
    }

    store.set({
      keySaved: keyStatus.state === 'ok',
    });
  } catch {
    // Keep the current lock on storage failure.
  }
};

const onLockAreaChanged = (changes: Record<string, unknown>): void => {
  if (Object.keys(changes).some((key) => isVaultKey(key) || key === SETTINGS_STORAGE_KEY)) {
    void refreshLock();
  }
};

const setKeyForm = (patch: Partial<KeyFormState>): void => {
  store.set({ keyForm: { ...store.get().keyForm, ...patch } });
};

let panelSettingsEpoch = 0;

const refreshPanelSettings = async (): Promise<void> => {
  const epoch = ++panelSettingsEpoch;

  try {
    const settings = await loadSettings();

    const spend = await readMonthSpend();

    if (epoch !== panelSettingsEpoch) {
      return;
    }

    const prev = store.get().panelSettings;

    store.set({
      panelSettings: {
        ...prev,
        loaded: true,
        imageOnly: settings.imageOnly,
        skipWebSearch: settings.skipWebSearch,
        costText: msg('optionsCostMonth', formatUsd(spend)),
      },
    });
  } catch {
    // Keep the previous settings form on storage failure.
  }
};

const onSettingsMode = (mode: 'imageOnly' | 'skipWebSearch', box: HTMLInputElement): void => {
  const checked = box.checked;

  void (async () => {
    try {
      await setMode(mode, checked);
    } catch {
      box.checked = !checked;
      announceAlert('settingsSaveFailed');
    }
  })();
};

const attachSettings = (el: HTMLElement | null): (() => void) | void => {
  if (!el) {
    return;
  }

  return attachSettingsInputs(el, {
    onMode: onSettingsMode,
  });
};

// Delivery cursor: the worker sequence orders records (timestamps only
// expire them), with a rank so a terminal write supersedes the collecting
// write of the same click without a panel reopen replaying either.
let lastSeenSeq = 0;

let lastSeenRank = -1;

let panelWindowPromise: Promise<number | undefined> | null = null;

// The handoff key is extension-global, so every open panel sees every
// request. Each panel resolves its own window once and ignores records
// stamped for another window: one click, one analysis, no cross-window
// display of another window's browsing.
const getPanelWindowId = (): Promise<number | undefined> => {
  if (!panelWindowPromise) {
    panelWindowPromise = chrome.windows.getCurrent().then(
      (win) => win?.id,
      () => undefined
    );
  }

  return panelWindowPromise;
};

// Request behind the displayed result, for follow-up stages that
// must bind to what the user sees rather than to any live run.
let displayedRequest: TripRequest | null = null;

let runSettings: ExtensionSettings | null = null;

let pendingRun: PendingRun | null = null;

let lastRun: PendingRun | null = null;

let currentCacheKey = '';

let currentPlace: PlaceResult | null = null;

let currentDestination = '';

let currentView = '';

let skeletonTimer: ReturnType<typeof setTimeout> | undefined;

let skeletonFor = '';

let skeletonShownAt = 0;

let staleTimer: ReturnType<typeof setTimeout> | undefined;

const lookAgainUsed = new Set<string>();

const announceStatus = (key: string, subs?: string | string[]): void => {
  const state = store.get();
  store.set({ status: msg(key, subs), statusSeq: state.statusSeq + 1 });
};

const announceAlert = (key: string, subs?: string | string[]): void => {
  const state = store.get();
  store.set({ alert: msg(key, subs), alertSeq: state.alertSeq + 1 });
};

const composedActiveElement = (): Element | null => document.activeElement;

const isTyping = (): boolean => {
  const active = composedActiveElement();

  return (
    !!active &&
    (active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      (active as HTMLElement).isContentEditable)
  );
};

const focusSelector = (selector: string): void => {
  (document.querySelector(selector) as HTMLElement | null)?.focus();
};

const focusResultHeading = (): void => {
  if (isTyping()) {
    return;
  }
  focusSelector('#result-slot h2');
};

// Every result-slot swap runs through here so a swap that removes the
// focused subtree falls back to the new visible heading, or to the
// persistent preview heading when the new tree has none.
const swapResultSlot = (build: () => void): void => {
  const before = composedActiveElement();
  build();

  if (before && !before.isConnected) {
    const heading = document.querySelector('#result-slot h2') as HTMLElement | null;

    if (heading) {
      heading.focus({ preventScroll: true });
    } else {
      document.getElementById('preview-heading')?.focus({ preventScroll: true });
    }
  }
};

const updatePreview = (srcUrl: string | null, kind: 'image' | 'frame' = 'image'): void => {
  if (srcUrl && isAllowedPreviewUrl(srcUrl)) {
    store.set({
      preview: {
        kind: 'image',
        src: srcUrl,
        frame: kind === 'frame',
        identified: null,
        overlay: null,
      },
    });
  } else {
    showPreviewPlaceholder();
  }
};

const showPreviewPlaceholder = (): void => {
  store.set({ preview: { kind: 'placeholder' } });
};

const setPreviewIdentified = (placeName: string): void => {
  const preview = store.get().preview;

  if (preview.kind === 'image' || preview.kind === 'crop') {
    store.set({ preview: { ...preview, identified: placeName } });
  }
};

const clearContentSlots = (): void => {
  store.set({
    links: null,
  });
};

const showLinks = (destination: string): void => {
  store.set({ links: destination });
};

type PrivacyMode =
  | 'image'
  | 'image-only'
  | 'image-pixels'
  | 'image-pixels-only'
  | 'cache'
  | 'idle'
  | 'video-frame'
  | 'video-frame-only'
  | 'video-url'
  | 'video-url-only'
  | 'names';

const privacyDestination = (): string => "Meta's Muse API";

const PRIVACY_KEYS: Record<PrivacyMode, string> = {
  image: 'privacyImage',
  'image-only': 'privacyImageOnly',
  'image-pixels': 'privacyImagePixels',
  'image-pixels-only': 'privacyImagePixelsOnly',
  cache: 'privacyCache',
  idle: 'privacyIdle',
  'video-frame': 'privacyVideoFrame',
  'video-frame-only': 'privacyVideoFrameOnly',
  'video-url': 'privacyVideoUrl',
  'video-url-only': 'privacyVideoUrlOnly',
  names: 'privacyNames',
};

const updatePrivacy = (mode: PrivacyMode): void => {
  store.set({ privacy: msg(PRIVACY_KEYS[mode], privacyDestination()) });
};

const clearCost = (): void => {
  store.set({ cost: '' });
};

// Settles the originating run's stage (stale runs included: the spend
// happened) but renders the cost line only for the UI owner.
const priceAndRecord = async (run: RunContext, stage: string): Promise<void> => {
  const rates = run.provider.getRates();

  const usd = estimateCostUsd(run.usage, rates);

  try {
    await settleStage(run, stage);
  } catch {
    // The run figure still renders; only the monthly total is stale.
  }

  if (!ownsUi(run)) {
    return;
  }
  store.set({
    cost: msg('costLine', [formatUsd(usd)]),
  });
};

const cancelSkeleton = (): void => {
  skeletonFor = '';

  if (skeletonTimer !== undefined) {
    clearTimeout(skeletonTimer);
    skeletonTimer = undefined;
  }
};

const showSkeleton = (id: string, phase: LoadingPhase = 'collecting'): void => {
  cancelSkeleton();
  skeletonFor = id;
  skeletonTimer = setTimeout(() => {
    if (skeletonFor !== id) {
      return;
    }
    swapResultSlot(() => {
      store.set({ result: { ...blankResultSlot(), card: { view: 'loading', phase } } });
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
    store.set({
      result: {
        ...blankResultSlot(),
        card: { view: 'idle', hint: msg('panelIdle') },
      },
    });
  });
  clearContentSlots();
  updatePrivacy('idle');
  clearCost();
};

const showOnboarding = (orphaned: boolean): void => {
  cancelSkeleton();
  currentView = 'onboarding';
  clearContentSlots();
  selectTab('settings');
  setKeyForm({ sessionOnly: runSettings?.sessionOnly ?? false });
  store.set({ showOrphaned: orphaned, replacing: false, keySaved: false });
  updatePrivacy('idle');
  clearCost();
};

const showConsent = (focusGate: boolean): void => {
  cancelSkeleton();
  currentView = 'consent';
  clearContentSlots();
  selectTab('main');
  swapResultSlot(() => {
    store.set({ result: { ...blankResultSlot(), consent: true } });
  });

  if (focusGate && !isTyping()) {
    focusSelector('#result-slot h2');
  }
};

// First-video gate: the same blocking inline-state pattern as consent
// (heading, disclosure, agree + explicit decline in DOM order), rendered in
// the light DOM because no key form is involved.
const showVideoConfirm = (rung2: boolean, imageOnly: boolean, focusGate: boolean): void => {
  cancelSkeleton();
  currentView = 'video-confirm';
  clearContentSlots();
  swapResultSlot(() => {
    store.set({ result: { ...blankResultSlot(), video: { rung2, imageOnly } } });
  });

  if (focusGate && !isTyping()) {
    focusSelector('#result-slot h2');
  }
};

const onVideoConfirmAgree = async (): Promise<void> => {
  try {
    await setVideoConsented();
  } catch {
    announceAlert('settingsSaveFailed');

    return;
  }
  await resumePending();
};

const onVideoConfirmCancel = (): void => {
  pendingRun = null;
  updatePreview(null);
  showIdle();
  announceStatus('statusVideoConfirmDeclined');
};

type GateResult =
  | { ready: true; provider: Provider; settings: ExtensionSettings; key: string }
  | { ready: false; reason: 'key' | 'consent' };

// Every run starts here: resolve the provider, then require a stored key and
// consent. A pending run routes to onboarding/consent so it can resume;
// without one the caller only announces the blocker.
const gateRun = async (pending: PendingRun | null): Promise<GateResult> => {
  const { provider, settings } = await getActiveProvider();
  runSettings = settings;

  const keyStatus = await loadKey(provider.id);

  if (keyStatus.state !== 'ok') {
    if (pending) {
      pendingRun = pending;
      showOnboarding(keyStatus.orphaned);
    }

    return { ready: false, reason: 'key' };
  }

  if (!(await hasConsented())) {
    if (pending) {
      pendingRun = pending;
      showConsent(false);
    }

    return { ready: false, reason: 'consent' };
  }

  return { ready: true, provider, settings, key: keyStatus.key };
};

const announceGate = (reason: 'key' | 'consent'): void => {
  announceStatus(reason === 'key' ? 'statusKeyNeeded' : 'statusConsentNeeded');
};

export const isLoopbackHttp = (srcUrl: string): boolean => {
  try {
    const parsed = new URL(srcUrl);

    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '[::1]')
    );
  } catch {
    return false;
  }
};

// Alternates belong to the displayed result: a new analysis run aborts
// their controller alongside the previous analysis. Ready alternate
// cards survive (their indices stay valid); only the in-flight marker
// resets, and the loser of a run race bows out by id.
const abortSiblings = (): void => {
  if (alternatesController) {
    alternatesController.abort();
    alternatesController = null;
  }
  alternatesLoading = null;
};

const cancelAllWork = (): void => {
  cancelActiveRun();
  abortSiblings();
};

// The visible Cancel beside every paid phase: runs in flight abort
// through their own paths (partial guide kept, spend settled, announced);
// with nothing in flight (still collecting), the panel idles directly.
const onCancelLoading = (): void => {
  const hadRun = cancelActiveRun() !== null;

  abortSiblings();

  if (!hadRun) {
    clearStaleTimer();
    updatePreview(null);
    showIdle();
    announceStatus('statusCanceled');
  }
};

// Follow-up stages of one request (guide after identify, look-again)
// inherit the live run's usage snapshot so the run figure stays cumulative
// while each stage still settles exactly once. Anything else (a new
// request, a replaced key, a switched provider or model) starts clean.
const pickInherit = (
  requestId: string,
  provider: Provider,
  key: string
): RunContext | undefined => {
  const current = activeRun();

  if (!current || current.cancelled) {
    return undefined;
  }

  if (current.requestId !== requestId) {
    return undefined;
  }

  if (current.provider.id !== provider.id || current.provider.modelName !== provider.modelName) {
    return undefined;
  }

  if (current.key !== key) {
    return undefined;
  }

  return current;
};

// Gate ticket: flows that install a run take one before gating and abandon
// when a newer flow started while they waited, so an older gate can never
// install over a newer run.
let runTicket = 0;

let lastAnalysisTicket = 0;

let runCounter = 0;

const nextRunId = (requestId: string): string => {
  runCounter += 1;

  return `${requestId}#${runCounter}`;
};

// Commits a run's working state to the displayed globals. Callers must own
// the UI; rendering from any other run's state is a cross-run leak.
const commitDisplayed = (run: RunContext, view: string): void => {
  currentPlace = run.place;
  currentDestination = run.destination;
  currentCacheKey = run.cacheKey;
  displayedRequest = run.request;
  markDisplayed(run.runId);
  currentView = view;
};

const clearStaleTimer = (): void => {
  if (staleTimer !== undefined) {
    clearTimeout(staleTimer);
    staleTimer = undefined;
  }
};

const fallbackFor = (signals: PageSignals): { label: string; href: string } | null => {
  const best = [signals.jsonLd[0]?.name, signals.ogTitle, signals.alt, signals.docTitle].find(
    (candidate) => candidate && candidate.trim()
  );
  if (!best) {
    return null;
  }
  const label = truncateCodePoints(best.trim(), 80);
  return {
    label,
    href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label)}`,
  };
};

type RunOutcome = 'result' | 'no-place' | 'error' | 'aborted' | 'partial';

// Rung-2 media for a video request: only when no frame was captured, the URL
// is server-fetchable, and the provider speaks video. Centralized so re-runs
// (look again, re-analyze, retry) route exactly like the first attempt.
const videoUrlForRequest = (request: TripRequest, provider: Provider): string | undefined =>
  request.mediaType === 'video' &&
  !request.frame &&
  provider.capabilities.video &&
  isRung2Usable(request.srcUrl)
    ? request.srcUrl
    : undefined;

const privacyForRequest = (
  request: TripRequest,
  settings: ExtensionSettings,
  provider: Provider
): PrivacyMode => {
  if (request.mediaType === 'video') {
    const full = videoUrlForRequest(request, provider) !== undefined;

    if (settings.imageOnly) {
      return full ? 'video-url-only' : 'video-frame-only';
    }

    return full ? 'video-url' : 'video-frame';
  }
  if ((request.frame?.dataUrl ?? request.srcUrl).startsWith('data:')) {
    return settings.imageOnly ? 'image-pixels-only' : 'image-pixels';
  }
  return settings.imageOnly ? 'image-only' : 'image';
};

const renderResultHeader = async (
  run: RunContext,
  place: PlaceResult,
  announce: boolean
): Promise<void> => {
  await settleSkeleton();

  if (!ownsUi(run)) {
    return;
  }

  cancelSkeleton();
  currentView = 'result';
  currentAlternates = null;
  const props = await resultCardProps(place);

  if (!ownsUi(run)) {
    return;
  }

  swapResultSlot(() => {
    store.set({ result: { ...blankResultSlot(), card: props } });
  });
  showLinks(currentDestination);
  setPreviewIdentified(place.placeName);
  if (announce) {
    announceStatus('statusFound', place.placeName);
  }
};

const renderNoPlace = async (
  request: TripRequest,
  origin: 'gesture' | 'panel',
  run: RunContext
): Promise<void> => {
  await settleSkeleton();

  if (!ownsUi(run)) {
    return;
  }

  cancelSkeleton();
  currentView = 'no-place';
  currentAlternates = null;
  const signals = request.signals ?? EMPTY_SIGNALS;
  swapResultSlot(() => {
    store.set({
      result: {
        ...blankResultSlot(),
        card: {
          view: 'no-place',
          showLookAgain: !lookAgainUsed.has(currentCacheKey),
          fallback: fallbackFor(signals),
        },
      },
    });
  });
  clearContentSlots();
  announceStatus('statusNoPlace');
  if (origin === 'panel') {
    focusResultHeading();
  }
};

const renderErrorCard = (
  titleKey: string,
  bodyKey: string,
  showRetry: boolean,
  withKeySetup: boolean,
  fallback: { label: string; href: string } | null = null
): void => {
  cancelSkeleton();
  currentView = 'error';
  currentAlternates = null;
  swapResultSlot(() => {
    store.set({
      result: {
        ...blankResultSlot(),
        card: {
          view: 'error',
          title: msg(titleKey),
          body: msg(bodyKey),
          showRetry,
          fallback,
        },
      },
    });
  });
  if (withKeySetup) {
    selectTab('settings');
    setKeyForm({ sessionOnly: runSettings?.sessionOnly ?? false });
    store.set({ replacing: true, showOrphaned: false });
  }
};

// Error-path footer: video runs report their rung (a frame-carrying request
// ran rung 1, a frameless one ran rung 2), everything else keeps the old rule.
const errorPrivacy = (request: TripRequest | null): PrivacyMode => {
  if (request?.mediaType === 'video') {
    return request.frame ? 'video-frame' : 'video-url';
  }
  if ((request?.frame?.dataUrl ?? request?.srcUrl ?? '').startsWith('data:')) {
    return 'image-pixels';
  }
  return 'image';
};

const ERROR_CARD_KEYS: Record<string, [string, string, string]> = {
  rate_limited: ['errorRateTitle', 'errorRateBody', 'alertRateLimited'],
  server: ['errorServerTitle', 'errorServerBody', 'alertServer'],
  network: ['errorNetworkTitle', 'errorNetworkBody', 'alertNetwork'],
  invalid_response: ['errorInvalidTitle', 'errorInvalidBody', 'alertInvalidResponse'],
};

const ERROR_CARD_FALLBACK: [string, string, string] = [
  'errorServerTitle',
  'errorServerBody',
  'alertServer',
];

const showProviderError = (
  err: unknown,
  request: TripRequest | null,
  privacyOverride?: PrivacyMode,
  skipAlert = false
): void => {
  const privacy = privacyOverride ?? errorPrivacy(request);

  const alert = (key: string): void => {
    if (!skipAlert) {
      announceAlert(key);
    }
  };

  if (!(err instanceof ProviderError)) {
    renderErrorCard('errorServerTitle', 'errorServerBody', true, false);
    alert('alertServer');
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
    alert('alertAuth');
    updatePrivacy(privacy);
    return;
  }
  const [titleKey, bodyKey, alertKey] = ERROR_CARD_KEYS[err.code] ?? ERROR_CARD_FALLBACK;
  renderErrorCard(titleKey, bodyKey, true, false);
  alert(alertKey);
  updatePrivacy(privacy);
};

// Failures before any billable work (auth, missing key, consent, setup,
// caller aborts) carry no usage honestly: the run figure stays exact.
// Any other failure without usage means billed tokens went unreported,
// so the run stops claiming a complete cost.
// An all-zero usage report means the failure carried no billing signal:
// absorbing it would let the run claim a complete cost it cannot prove.
const usageIsEmpty = (usage: Usage): boolean =>
  usage.inputTokens <= 0 &&
  usage.outputTokens <= 0 &&
  (usage.cachedInputTokens ?? 0) <= 0 &&
  usage.searchCount <= 0 &&
  usage.flatFeesUsd <= 0;

const recordPartialUsage = (run: RunContext, stage: string, err: unknown): void => {
  if (err instanceof ProviderError && err.usage && !usageIsEmpty(err.usage)) {
    absorbRunUsage(run, err.usage);
  }

  void priceAndRecord(run, stage);
};

interface IdentifyArgs {
  run: RunContext;
  origin: 'gesture' | 'panel';
  rejectedPlace?: string;
  requestOverride?: TripRequest;
}

// Guesses below this confidence render the no-place card instead of a
// guide: the model was told to guess rather than refuse, so the panel owns
// the refusal line. Tune against live traffic.
const NO_PLACE_MIN_CONFIDENCE = 0.35;

const runIdentify = async (args: IdentifyArgs): Promise<RunOutcome> => {
  const { run, origin, rejectedPlace } = args;
  const request = args.requestOverride ?? run.request;

  if (!request) {
    return 'error';
  }

  const signals = request.signals ?? EMPTY_SIGNALS;
  const signalsText = formatSignalsForPrompt(signals, run.settings.imageOnly);
  const privacy = privacyForRequest(request, run.settings, run.provider);
  let identify;
  try {
    identify = await run.provider.identifyPlace(run.key, {
      imageUrl: request.frame?.dataUrl ?? request.srcUrl,
      signalsText,
      signal: run.signal,
      rejectedPlace,
      videoUrl: videoUrlForRequest(request, run.provider),
    });
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'aborted') {
      recordPartialUsage(run, 'identify', err);

      if (activeRun() !== null) {
        return 'aborted';
      }

      cancelSkeleton();
      showIdle();
      announceStatus('statusCanceled');

      return 'aborted';
    }
    recordPartialUsage(run, 'identify', err);
    await priceAndRecord(run, 'identify');

    if (!ownsUi(run)) {
      return 'error';
    }

    // A 400 on the image-bearing identify means the model could not fetch
    // the remote image, so the panel retries automatically with downloaded
    // bytes instead of asking the user to press a button.
    if (
      err instanceof ProviderError &&
      err.status === 400 &&
      !request.mediaType &&
      !request.frame &&
      !request.dataPending &&
      (request.srcUrl.startsWith('https://') || isLoopbackHttp(request.srcUrl))
    ) {
      const retried = await fetchRetry(run.signal);

      if (retried || run.signal.aborted) {
        return 'aborted';
      }

      showProviderError(err, request, undefined, true);

      return 'error';
    }

    showProviderError(err, request);
    return 'error';
  }
  absorbRunUsage(run, identify.usage);

  if (!ownsUi(run)) {
    await priceAndRecord(run, 'identify');

    return 'aborted';
  }

  run.place = identify.place;
  await setCacheEntry(run.cacheKey, {
    place: identify.place,
    usage: { ...run.usage },
  });

  if (!ownsUi(run)) {
    return 'aborted';
  }

  if (!identify.place.identified || identify.place.confidence < NO_PLACE_MIN_CONFIDENCE) {
    // Stash the guess: look-again rejects it to force a different candidate.
    commitDisplayed(run, 'no-place');
    await renderNoPlace(request, origin, run);

    if (!ownsUi(run)) {
      return 'aborted';
    }

    await priceAndRecord(run, 'identify');

    if (!ownsUi(run)) {
      return 'no-place';
    }

    updatePrivacy(privacy);
    return 'no-place';
  }
  run.destination = buildDestination(
    identify.place.placeName,
    identify.place.city,
    identify.place.country
  );
  commitDisplayed(run, 'result');
  await renderResultHeader(run, identify.place, true);

  if (!ownsUi(run)) {
    return 'aborted';
  }

  await priceAndRecord(run, 'identify');

  if (!ownsUi(run)) {
    return 'result';
  }

  updatePrivacy(privacy);
  store.set({ resultBusy: false });
  if (origin === 'panel') {
    focusResultHeading();
  }
  return 'result';
};

const identifyKeyFor = async (run: RunContext, mediaSeed: string): Promise<string> =>
  hashIdentifyKey({
    mediaSeed,
    pageUrl: run.request?.pageUrl ?? '',
    imageOnly: run.settings.imageOnly,
  });

const renderCached = async (
  run: RunContext,
  entry: CacheEntry,
  origin: 'gesture' | 'panel'
): Promise<void> => {
  if (!ownsUi(run)) {
    return;
  }

  cancelSkeleton();
  run.place = entry.place;
  // Same refusal line as a live run: a cached low-confidence guess shows
  // the no-place card instead of flipping to a result on revisit.
  if (!entry.place.identified || entry.place.confidence < NO_PLACE_MIN_CONFIDENCE) {
    commitDisplayed(run, 'no-place');
    swapResultSlot(() => {
      store.set({
        result: {
          ...blankResultSlot(),
          card: {
            view: 'no-place',
            showLookAgain: !lookAgainUsed.has(run.cacheKey),
            fallback: run.request ? fallbackFor(run.request.signals ?? EMPTY_SIGNALS) : null,
          },
        },
      });
    });
    clearContentSlots();
    store.set({ cost: msg('costLine', [formatUsd(0)]) });
    updatePrivacy('cache');
    announceStatus('statusNoPlace');
    if (origin === 'panel') {
      focusResultHeading();
    }
    return;
  }
  run.destination = buildDestination(entry.place.placeName, entry.place.city, entry.place.country);
  currentAlternates = null;
  commitDisplayed(run, 'result');
  const props = await resultCardProps(entry.place);

  if (!ownsUi(run)) {
    return;
  }

  swapResultSlot(() => {
    store.set({ result: { ...blankResultSlot(), card: props } });
  });
  showLinks(currentDestination);
  setPreviewIdentified(entry.place.placeName);
  store.set({ cost: msg('costLine', [formatUsd(0)]) });
  updatePrivacy('cache');
  announceStatus('statusCacheHit', entry.place.placeName);
  if (origin === 'panel') {
    focusResultHeading();
  }
};

type VideoRoute =
  { kind: 'frame' } | { kind: 'rung2' } | { kind: 'error'; titleKey: string; bodyKey: string };

const routeVideoRequest = (request: TripRequest, provider: Provider): VideoRoute => {
  if (request.frame) {
    return { kind: 'frame' };
  }
  if (request.frameError === 'drm') {
    return { kind: 'error', titleKey: 'errorVideoTitle', bodyKey: 'errorVideoBody' };
  }
  if (isRung2Usable(request.srcUrl)) {
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
  run: RunContext,
  origin: 'gesture' | 'panel',
  superseded: boolean
): Promise<void> => {
  const request = run.request;

  if (!request) {
    return;
  }

  const route = routeVideoRequest(request, run.provider);
  if (route.kind === 'error') {
    updatePreview(null);
    renderErrorCard(
      route.titleKey,
      route.bodyKey,
      false,
      false,
      fallbackFor(request.signals ?? EMPTY_SIGNALS)
    );
    announceAlert('alertVideoUnreadable');
    updatePrivacy('idle');
    return;
  }
  if (!(await hasVideoConsented())) {
    if (!ownsUi(run)) {
      return;
    }

    pendingRun = { kind: 'request', request };
    updatePreview(request.frame?.dataUrl ?? null, request.frame ? 'frame' : 'image');
    showVideoConfirm(route.kind === 'rung2', run.settings.imageOnly, origin === 'panel');
    announceStatus('statusVideoConfirmNeeded');
    return;
  }

  if (!ownsUi(run)) {
    return;
  }

  if (route.kind === 'frame' && request.frame) {
    updatePreview(request.frame.dataUrl, 'frame');
    run.cacheKey = await identifyKeyFor(run, frameCacheSeed(request.frame.time, request.srcUrl));
  } else {
    updatePreview(null);
    run.cacheKey = await identifyKeyFor(run, request.srcUrl);
  }

  if (!ownsUi(run)) {
    return;
  }

  const cached = await getCacheEntry(run.cacheKey);

  if (!ownsUi(run)) {
    return;
  }

  if (cached) {
    await renderCached(run, cached, origin);
    return;
  }
  announceStatus(
    superseded
      ? 'statusCanceledNew'
      : route.kind === 'frame'
        ? 'statusAnalyzingFrame'
        : 'statusAnalyzingVideo'
  );
  showSkeleton(request.requestId, 'identifying');
  await runIdentify({ run, origin });
};

const runAnalysis = async (request: TripRequest, origin: 'gesture' | 'panel'): Promise<void> => {
  const superseded = activeRun() !== null;
  const ticket = ++runTicket;
  lastAnalysisTicket = ticket;
  cancelAllWork();
  clearStaleTimer();
  lastRun = { kind: 'request', request };
  pendingRun = null;
  updatePreview(request.srcUrl || null);
  clearCost();
  const gate = await gateRun({ kind: 'request', request });

  if (ticket !== runTicket) {
    return;
  }

  if (!gate.ready) {
    announceGate(gate.reason);
    return;
  }
  const { provider, settings, key } = gate;
  const run = startRun(
    {
      runId: nextRunId(request.requestId),
      requestId: request.requestId,
      kind: request.mediaType === 'video' ? 'video' : 'identify',
      provider,
      settings,
      key,
      request,
    },
    { inheritFrom: pickInherit(request.requestId, provider, key), abortSiblings }
  );
  selectTab('main');
  if (request.mediaType === 'video') {
    await runVideoAnalysis(run, origin, superseded);
    return;
  }
  if (request.dataPending || !request.srcUrl) {
    renderErrorCard('errorDataTitle', 'errorDataBody', false, false);
    announceAlert('errorDataBody');
    updatePrivacy('idle');
    return;
  }
  run.cacheKey = await identifyKeyFor(run, request.srcUrl);

  if (!ownsUi(run)) {
    return;
  }

  const cached = await getCacheEntry(run.cacheKey);

  if (!ownsUi(run)) {
    return;
  }

  if (cached) {
    await renderCached(run, cached, origin);
    return;
  }
  announceStatus(superseded ? 'statusCanceledNew' : 'statusAnalyzing');
  showSkeleton(request.requestId, 'identifying');
  await runIdentify({ run, origin });
};

const handle = async (value: unknown): Promise<void> => {
  const parsed = TRIP_REQUEST_SCHEMA.safeParse(value);
  if (!parsed.success) {
    return;
  }
  const request = parsed.data;
  const panelWindowId = await getPanelWindowId();
  if (request.windowId !== panelWindowId) {
    return;
  }
  if (Date.now() - request.at > HANDOFF_TTL_MS) {
    // Expired records never run; the ack clears the stale slot when it
    // still holds this sequence.
    await ackRequest(request.windowId, request.seq);
    return;
  }
  const rank = request.status === 'collecting' ? 0 : 1;
  if (request.seq < lastSeenSeq) {
    return;
  }
  if (request.seq === lastSeenSeq && rank <= lastSeenRank) {
    return;
  }
  lastSeenSeq = request.seq;
  lastSeenRank = rank;
  if (request.status === 'error') {
    await ackRequest(request.windowId, request.seq);
    renderErrorCard('handoffFailedTitle', 'handoffFailedBody', false, false);
    announceAlert('handoffFailedBody');
    updatePrivacy('idle');
    return;
  }
  updatePreview(request.srcUrl || null);
  if (request.status === 'collecting') {
    announceStatus('statusAnalyzing');
    showSkeleton(request.requestId);
    clearStaleTimer();
    const seq = request.seq;
    staleTimer = setTimeout(() => {
      if (lastSeenSeq === seq && lastSeenRank === 0) {
        lastSeenRank = -1;
        updatePreview(null);
        showIdle();
      }
    }, STALE_COLLECTING_MS);
    return;
  }
  // Consume-on-read: acknowledge the terminal record before running so a
  // panel reopen can never replay (and rebill) a finished run. The worker
  // clears the slot only if it still holds this sequence.
  await ackRequest(request.windowId, request.seq);
  try {
    await runAnalysis(request, 'gesture');
  } catch (err) {
    // Entry-point net: an unexpected throw surfaces the error card
    // instead of stranding the panel on a skeleton. A newer flow that
    // started while this one unwound owns the UI, so stale errors bow
    // out instead of canceling it.
    if (lastAnalysisTicket !== runTicket) {
      return;
    }
    store.set({ resultBusy: false });
    cancelAllWork();
    showProviderError(err, request);
  }
};

// ---- SAM crop-to-landmark ----

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
const trySamCrop = async (run: RunContext, request: TripRequest): Promise<SamCrop | null> => {
  try {
    return await samCropAttempt(run, request);
  } catch {
    return null;
  }
};

const samCropAttempt = async (run: RunContext, request: TripRequest): Promise<SamCrop | null> => {
  const provider = run.provider;
  const direct =
    request.frame?.dataUrl ?? (request.srcUrl.startsWith('data:image/') ? request.srcUrl : null);
  let inputBytes = direct ? dataUrlToBytes(direct) : null;
  if (!inputBytes) {
    const loopback = isLoopbackHttp(request.srcUrl);
    if (request.mediaType || (!request.srcUrl.startsWith('https://') && !loopback)) {
      return null;
    }
    let origin: string;
    try {
      origin = new URL(request.srcUrl).origin;
    } catch {
      return null;
    }
    // Prompt-free first: the page tab fetches CORS-open hosts with no
    // extension permission. Any tab failure falls back to the grant path.
    try {
      inputBytes = await fetchImageBytesViaTab(
        request.tabId,
        request.frameId ?? 0,
        request.srcUrl,
        run.signal
      );
    } catch {
      inputBytes = null;
    }
    if (!inputBytes) {
      if (run.signal.aborted) {
        return null;
      }
      let outcome: { granted: boolean; result?: Uint8Array };
      try {
        outcome = await withTempGrant(origin, loopback, async () =>
          fetchImageBytes(request.srcUrl, run.signal)
        );
      } catch {
        return null;
      }
      if (!outcome.granted || !outcome.result) {
        return null;
      }
      inputBytes = outcome.result;
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
    const segment = await provider.segmentLandmark(run.key, {
      imageDataUrl: samDataUrl,
      signal: run.signal,
    });
    absorbRunUsage(run, segment.usage);
    const box = selectSamBox(parseSamBoxes(segment.text), bitmap.width, bitmap.height);
    if (!box || !ownsUi(run)) {
      return null;
    }
    showSamOverlay(box, bitmap.width, bitmap.height);
    announceStatus('samZoomed');
    if (!prefersReducedMotion()) {
      await new Promise((resolve) => setTimeout(resolve, SAM_OVERLAY_DWELL_MS));
    }
    if (!ownsUi(run)) {
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
  const frame = document.getElementById('preview-frame');
  const img = frame?.querySelector('img');
  if (!frame || !img) {
    return;
  }
  const preview = store.get().preview;
  if (preview.kind !== 'image') {
    return;
  }
  const frameRect = frame.getBoundingClientRect();
  const imgRect = img.getBoundingClientRect();
  store.set({
    preview: {
      ...preview,
      overlay: {
        left: imgRect.left - frameRect.left + (box.x1 / width) * imgRect.width,
        top: imgRect.top - frameRect.top + (box.y1 / height) * imgRect.height,
        width: ((box.x2 - box.x1) / width) * imgRect.width,
        height: ((box.y2 - box.y1) / height) * imgRect.height,
      },
    },
  });
};

const showSamCrop = (dataUrl: string): void => {
  store.set({ preview: { kind: 'crop', src: dataUrl, identified: null } });
};

const lookAgain = async (): Promise<void> => {
  const request = displayedRequest;
  if (!request?.srcUrl || !currentCacheKey || lookAgainUsed.has(currentCacheKey)) {
    return;
  }
  const cacheKey = currentCacheKey;
  const rejectedPlace = currentPlace?.placeName || undefined;
  const ticket = ++runTicket;
  store.set({ resultBusy: true });
  announceStatus('statusAnalyzing');
  try {
    await netLookAgain(request, ticket, cacheKey, rejectedPlace);
  } finally {
    store.set({ resultBusy: false });
  }
};

const netLookAgain = async (
  request: TripRequest,
  ticket: number,
  cacheKey: string,
  rejectedPlace: string | undefined
): Promise<void> => {
  try {
    const gate = await gateRun({ kind: 'request', request });

    if (ticket !== runTicket) {
      return;
    }

    if (!gate.ready) {
      announceGate(gate.reason);
      return;
    }
    const { provider, settings, key } = gate;
    const run = startRun(
      {
        runId: nextRunId(`${request.requestId}-look-again`),
        requestId: request.requestId,
        kind: 'identify',
        provider,
        settings,
        key,
        request,
        cacheKey,
      },
      { inheritFrom: pickInherit(request.requestId, provider, key), abortSiblings }
    );
    showSkeleton(request.requestId, 'identifying');
    let samCrop: SamCrop | null = null;
    if (provider.capabilities.segmentation) {
      samCrop = await trySamCrop(run, request);

      if (!ownsUi(run)) {
        // A cancel during the SAM overlay settles like an aborted
        // identify (the SAM spend counts); a superseding run owns the UI.
        await priceAndRecord(run, 'identify');

        if (activeRun() === null) {
          cancelSkeleton();
          showIdle();
          announceStatus('statusCanceled');
        }

        return;
      }
    }
    const identifyRequest =
      samCrop && request.frame
        ? { ...request, frame: { ...request.frame, dataUrl: samCrop.dataUrl } }
        : samCrop
          ? { ...request, srcUrl: samCrop.dataUrl }
          : request;
    const outcome = await runIdentify({
      run,
      origin: 'panel',
      rejectedPlace,
      requestOverride: identifyRequest,
    });

    // One shot per image, spent only on a completed look: failures and
    // cancels leave the button for another attempt.
    if (outcome === 'result' || outcome === 'no-place') {
      lookAgainUsed.add(cacheKey);
    }
  } catch (err) {
    if (ticket !== runTicket) {
      return;
    }
    cancelAllWork();
    showProviderError(err, request);
  }
};

const reanalyze = async (): Promise<void> => {
  const request = displayedRequest;
  if (!request?.srcUrl || !currentPlace) {
    return;
  }
  const rejectedPlace = currentPlace.placeName;
  const ticket = ++runTicket;
  store.set({ resultBusy: true });
  announceStatus('statusAnalyzing');
  try {
    await netReanalyze(request, ticket, rejectedPlace);
  } finally {
    store.set({ resultBusy: false });
  }
};

const netReanalyze = async (
  request: TripRequest,
  ticket: number,
  rejectedPlace: string
): Promise<void> => {
  try {
    const gate = await gateRun({ kind: 'request', request });

    if (ticket !== runTicket) {
      return;
    }

    if (!gate.ready) {
      announceGate(gate.reason);
      return;
    }
    const { provider, settings, key } = gate;
    const run = startRun(
      {
        runId: nextRunId(`${request.requestId}-reanalyze`),
        requestId: request.requestId,
        kind: 'identify',
        provider,
        settings,
        key,
        request,
        cacheKey: currentCacheKey,
      },
      { inheritFrom: pickInherit(request.requestId, provider, key), abortSiblings }
    );
    showSkeleton(request.requestId, 'identifying');
    await runIdentify({ run, origin: 'panel', rejectedPlace });
  } catch (err) {
    if (ticket !== runTicket) {
      return;
    }
    cancelAllWork();
    showProviderError(err, request);
  }
};

const netPanelRun = async (task: () => Promise<void>, request: TripRequest): Promise<void> => {
  try {
    await task();
  } catch (err) {
    if (lastAnalysisTicket !== runTicket) {
      return;
    }
    store.set({ resultBusy: false });
    cancelAllWork();
    showProviderError(err, request);
  }
};

const retry = async (): Promise<void> => {
  const target = lastRun;
  if (!target) {
    return;
  }
  clearContentSlots();
  await netPanelRun(() => runAnalysis(target.request, 'panel'), target.request);
};

// The model could not fetch the remote image, so the panel downloads the
// bytes itself and retries with a data: URL. The tab fetch runs first with
// no permission prompt; only its failure falls back to the
// permission-gated direct fetch. The grant is removed in the finally so it
// never outlives the attempt. Resolves true when a replacement run
// started.
const fetchRetry = async (signal?: AbortSignal): Promise<boolean> => {
  const target =
    lastRun?.kind === 'request'
      ? lastRun.request
      : displayedRequest?.mediaType === undefined
        ? displayedRequest
        : null;
  const srcUrl = target?.srcUrl ?? '';

  const loopback = isLoopbackHttp(srcUrl);

  if (
    !target ||
    target.mediaType ||
    target.dataPending ||
    (!srcUrl.startsWith('https://') && !loopback)
  ) {
    return false;
  }

  let origin: string;

  try {
    origin = new URL(srcUrl).origin;
  } catch {
    return false;
  }

  const controller = new AbortController();

  // The caller's signal aborts in-flight fetches. The replacement
  // runAnalysis owns the takeover (cancel, timers, run ticket), so this
  // retry never cancels the calling run itself.
  const stop = signal ?? controller.signal;

  const ticket = runTicket;

  // A cancel or a newer run that lands during the downscale must not
  // resurrect as a replacement run.
  const runWithBytes = async (bytes: Uint8Array): Promise<boolean> => {
    const dataUrl = await downscaleToJpegDataUrl(bytes);

    if (!stop.aborted && runTicket === ticket) {
      announceStatus('statusAnalyzing');
      await runAnalysis({ ...target, srcUrl: dataUrl, dataPending: false }, 'panel');

      return true;
    }

    return false;
  };

  // Prompt-free first: fetch inside the page tab, where CORS-open image
  // hosts need no extension permission.
  try {
    const bytes = await fetchImageBytesViaTab(target.tabId, target.frameId ?? 0, srcUrl, stop);

    if (stop.aborted) {
      return false;
    }

    try {
      return await runWithBytes(bytes);
    } catch {
      announceAlert('fetchFailed');

      return false;
    }
  } catch {
    if (stop.aborted) {
      return false;
    }
    // The tab is gone, unscriptable, or the host rejects page fetches:
    // fall through to the permission-gated direct fetch.
  }

  if (stop.aborted) {
    return false;
  }

  let started = false;

  const outcome = await withTempGrant(origin, loopback, async () => {
    if (stop.aborted) {
      return;
    }

    try {
      started = await runWithBytes(await fetchImageBytes(srcUrl, stop));
    } catch {
      announceAlert('fetchFailed');
    }
  });

  if (!outcome.granted) {
    announceAlert('fetchDenied');
  }

  return started;
};

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

const confidenceView = (place: PlaceResult): ConfidenceView => {
  const band =
    place.confidence >= 0.8
      ? 'confidenceHigh'
      : place.confidence >= 0.6
        ? 'confidenceMedium'
        : 'confidenceLow';

  return {
    line: msg('confidenceLine', [msg(band), place.confidence.toFixed(2)]),
    showScale: true,
  };
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

const resultCardProps = async (
  place: PlaceResult
): Promise<{
  view: 'result';
  place: PlaceResult;
  lowConfidence: boolean;
  canReanalyze: boolean;
  confidence: ConfidenceView;
  sourceHost: string | null;
  alternates: AlternatesView;
}> => {
  const host = sourceHostFor(displayedRequest);

  const alternates = alternatesView();

  return {
    view: 'result',
    place,
    lowConfidence: place.confidence < 0.6,
    canReanalyze: (displayedRequest?.srcUrl ?? '') !== '',
    confidence: confidenceView(place),
    sourceHost: host === '' ? null : host,
    alternates,
  };
};

const refreshResultCard = async (): Promise<void> => {
  if (currentView !== 'result' || !currentPlace) {
    return;
  }
  const place = currentPlace;
  const props = await resultCardProps(place);

  if (currentView !== 'result' || currentPlace !== place) {
    return;
  }

  store.set({ result: { ...blankResultSlot(), card: props } });
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
  // Unique stage per alternates call: settlement dedupes on run+stage,
  // so a shared name would drop every repeat after the first from the
  // monthly total.
  const stage = `alternates:${mine}`;
  alternatesLoading = intent;
  currentAlternates = null;
  await refreshResultCard();
  announceStatus(FINDING_KEYS[intent]);
  const host = activeRun();
  const gate = await gateRun(null);
  if (!gate.ready) {
    if (mine !== alternatesRunId || (host && activeRun() !== host)) {
      return;
    }
    alternatesLoading = null;
    await refreshResultCard();
    announceGate(gate.reason);
    return;
  }
  if (host && activeRun() !== host) {
    return;
  }
  const { provider, settings, key } = gate;
  const bucket = host ?? createEphemeralRun('alternates', provider, settings, key);
  let result;
  try {
    result = await provider.findAlternates(key, {
      placeName: place.placeName,
      city: place.city,
      country: place.country,
      intent,
      skipWebSearch: settings.skipWebSearch,
      signal: controller.signal,
    });
  } catch (err) {
    if (alternatesController === controller) {
      alternatesController = null;
    }
    if (err instanceof ProviderError && err.code === 'aborted') {
      return;
    }
    recordPartialUsage(bucket, stage, err);
    if (mine !== alternatesRunId || (host && activeRun() !== host)) {
      return;
    }
    alternatesLoading = null;
    await refreshResultCard();
    updatePrivacy('names');
    announceAlert('alternatesFail');
    return;
  }
  if (alternatesController === controller) {
    alternatesController = null;
  }
  absorbRunUsage(bucket, result.usage);
  if (mine !== alternatesRunId || (host && activeRun() !== host)) {
    await priceAndRecord(bucket, stage);
    return;
  }
  currentAlternates = { intent, alternatives: result.alternatives };
  alternatesLoading = null;
  await refreshResultCard();
  await priceAndRecord(bucket, stage);
  updatePrivacy('names');
  announceStatus('alternatesReady', String(result.alternatives.length));
};

const onAlternates = async (intent: AlternateIntent): Promise<void> => {
  try {
    await runAlternates(intent);
  } catch {
    alternatesLoading = null;
    await refreshResultCard();
    announceAlert('alternatesFail');
  }
};

const onAlternatesCancel = (): void => {
  alternatesRunId += 1;
  alternatesController?.abort();
  alternatesController = null;
  alternatesLoading = null;
  void refreshResultCard();
  announceStatus('statusCanceled');
};

const resumePending = async (): Promise<void> => {
  const pending = pendingRun;
  pendingRun = null;
  if (!pending) {
    showIdle();
    return;
  }
  await netPanelRun(() => runAnalysis(pending.request, 'panel'), pending.request);
};

const onKeySave = async (key: string): Promise<void> => {
  const sessionOnly = store.get().keyForm.sessionOnly;
  setKeyForm({ pending: true });
  announceStatus('statusValidatingKey');
  const { provider, settings } = await getActiveProvider();
  runSettings = settings;
  try {
    await provider.testKey(key);
  } catch (err) {
    const failureKey =
      err instanceof ProviderError && err.code === 'auth'
        ? 'keyErrorRejected'
        : err instanceof ProviderError && err.code === 'network'
          ? 'keyErrorNetwork'
          : 'keyErrorRetry';
    setKeyForm({ pending: false, error: msg(failureKey) });
    announceStatus(failureKey);
    return;
  }
  try {
    await saveKey(provider.id, key, sessionOnly);
    runSettings = { ...settings, sessionOnly };
    await saveSettings(runSettings);
  } catch {
    setKeyForm({ pending: false, error: msg('keyErrorRetry') });
    announceStatus('keyErrorRetry');
    return;
  }
  setKeyForm({ pending: false, error: null, resetKey: store.get().keyForm.resetKey + 1 });
  store.set({ keySaved: true, replacing: false, showOrphaned: false });
  selectTab('main');
  announceStatus('statusKeySaved');
  if (!(await hasConsented())) {
    showConsent(true);
    return;
  }
  await resumePending();
};

const showKeyCleared = (): void => {
  store.set({
    keySaved: false,
    replacing: false,
    showOrphaned: false,
  });
  setKeyForm({ pending: false, error: null, resetKey: store.get().keyForm.resetKey + 1 });
  selectTab('settings');
  announceStatus('statusKeyCleared');
};

const onRemoveKey = (): void => {
  void (async () => {
    const { provider } = await getActiveProvider();

    try {
      await clearKey(provider.id);
    } catch {
      setKeyForm({ pending: false, error: msg('settingsSaveFailed') });
      announceAlert('settingsSaveFailed');

      return;
    }

    showKeyCleared();
  })();
};

const onConsentDecision = async (agreed: boolean): Promise<void> => {
  if (!agreed) {
    pendingRun = null;
    updatePreview(null);
    showIdle();
    announceStatus('statusConsentDeclined');
    return;
  }
  try {
    await setConsented();
  } catch {
    announceAlert('settingsSaveFailed');
    return;
  }
  await resumePending();
};

const onSessionOnlyChange = async (checked: boolean): Promise<void> => {
  const { provider, settings } = await getActiveProvider();

  // Optimistic for the remount; the settled state below always comes from
  // verified storage, never from the previous checkbox value.
  setKeyForm({ sessionOnly: checked });

  let result;

  try {
    result = await setKeyMode(provider.id, checked);
  } catch {
    runSettings = { ...settings };
    setKeyForm({ sessionOnly: settings.sessionOnly, error: msg('settingsSaveFailed') });
    announceStatus('settingsSaveFailed');

    return;
  }

  runSettings = { ...settings, sessionOnly: result.sessionOnly };

  if (result.error) {
    setKeyForm({ sessionOnly: result.sessionOnly, error: msg('settingsSaveFailed') });
    announceStatus('settingsSaveFailed');

    return;
  }

  setKeyForm({ sessionOnly: result.sessionOnly, error: null });
};

interface PreviewFrameProps {
  preview: PreviewState;
}

const PreviewFrame = ({ preview }: PreviewFrameProps) => {
  if (preview.kind === 'placeholder') {
    return <span>{msg('previewUnavailable')}</span>;
  }
  if (preview.kind === 'crop') {
    return (
      <>
        <img
          referrerPolicy="no-referrer"
          alt={
            preview.identified
              ? msg('previewAltIdentified', preview.identified)
              : msg('previewAltCrop')
          }
          src={preview.src}
          onError={() => showPreviewPlaceholder()}
        />
        <p className="preview-caption">{msg('samZoomCaption')}</p>
      </>
    );
  }
  return (
    <>
      <img
        referrerPolicy="no-referrer"
        alt={
          preview.identified
            ? msg('previewAltIdentified', preview.identified)
            : msg(preview.frame ? 'previewAltFrame' : 'previewAltImage')
        }
        src={preview.src}
        onError={() => showPreviewPlaceholder()}
      />
      {preview.overlay ? (
        <div
          className="sam-box"
          aria-hidden="true"
          style={{
            left: `${preview.overlay.left}px`,
            top: `${preview.overlay.top}px`,
            width: `${preview.overlay.width}px`,
            height: `${preview.overlay.height}px`,
          }}
        />
      ) : null}
    </>
  );
};

const onTabKeyDown = (event: ReactKeyboardEvent): void => {
  const tabs = enabledTabs();
  const currentId = (event.target as HTMLElement).id;
  const current = (Object.keys(TAB_IDS) as PanelTab[]).find((tab) => TAB_IDS[tab] === currentId);
  if (!current) {
    return;
  }
  let next: PanelTab | null = null;
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    const at = tabs.indexOf(current);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    next = tabs[(at + step + tabs.length) % tabs.length] ?? null;
  } else if (event.key === 'Home') {
    next = tabs[0] ?? null;
  } else if (event.key === 'End') {
    next = tabs[tabs.length - 1] ?? null;
  }
  if (next) {
    event.preventDefault();
    selectTab(next);
    document.getElementById(TAB_IDS[next])?.focus();
  }
};

const SidepanelApp = () => {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const keyForm = state.keyForm;
  const main = state.tab === 'main';
  const selected = (tab: PanelTab): boolean => state.tab === tab;
  return (
    <main ref={attachSettings}>
      <h1 id="page-title" className="visually-hidden">
        {msg('appName')}
      </h1>
      <div id="status-region" role="status" className="visually-hidden">
        <span key={state.statusSeq}>{state.status}</span>
      </div>
      <div id="alert-region" role="alert" className="visually-hidden">
        <span key={state.alertSeq}>{state.alert}</span>
      </div>
      <div id="tab-bar" role="tablist" aria-label={msg('tabsLabel')} onKeyDown={onTabKeyDown}>
        <button
          type="button"
          id="tab-main"
          role="tab"
          aria-selected={selected('main')}
          aria-controls="main-panel"
          tabIndex={selected('main') ? 0 : -1}
          onClick={() => selectTab('main')}
        >
          {msg('mainTab')}
        </button>
        <button
          type="button"
          id="tab-settings"
          role="tab"
          aria-selected={selected('settings')}
          aria-controls="settings-panel"
          tabIndex={selected('settings') ? 0 : -1}
          onClick={() => selectTab('settings')}
        >
          {msg('settingsTab')}
        </button>
      </div>
      <section
        id="main-panel"
        role="tabpanel"
        aria-labelledby="tab-main"
        hidden={!main || undefined}
      >
        <header id="preview-header">
          <h2 id="preview-heading" className="visually-hidden" tabIndex={-1}>
            {msg('previewHeading')}
          </h2>
          <div id="preview-frame">
            <PreviewFrame preview={state.preview} />
          </div>
        </header>
        <div id="result-slot" aria-busy={state.resultBusy || undefined}>
          {state.result.card ? (
            <TripCard
              card={state.result.card}
              callbacks={{
                onReanalyze: () => void reanalyze(),
                onRetry: () => void retry(),
                onLookAgain: () => void lookAgain(),
                onAlternates: (intent) => void onAlternates(intent),
                onCancelAlternates: onAlternatesCancel,
                onCancelLoading: () => onCancelLoading(),
                onDismissError: () => showIdle(),
              }}
            />
          ) : null}
          {state.result.consent ? (
            <KeySetup
              mode="consent"
              pending={keyForm.pending}
              error={keyForm.error}
              sessionOnly={keyForm.sessionOnly}
              resetKey={keyForm.resetKey}
              callbacks={{
                onSave: (key) => void onKeySave(key),
                onError: (text) => setKeyForm({ error: text }),
                onSessionOnlyChange: (checked) => void onSessionOnlyChange(checked),
                onConsentDecision: (agreed) => void onConsentDecision(agreed),
              }}
            />
          ) : null}
          {state.result.video ? (
            <>
              <h2 tabIndex={-1}>{msg('videoConfirmTitle')}</h2>
              <p>{msg('videoConfirmBody')}</p>
              {state.result.video.rung2 ? <p>{msg('videoConfirmRung2Note')}</p> : null}
              {state.result.video.imageOnly ? <p>{msg('videoConfirmImageOnly')}</p> : null}
              <div className="confirm-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void onVideoConfirmAgree()}
                >
                  {msg('videoConfirmAgree')}
                </button>
                <button type="button" onClick={() => onVideoConfirmCancel()}>
                  {msg('videoConfirmCancel')}
                </button>
              </div>
            </>
          ) : null}
        </div>
        <section id="links-slot" aria-labelledby="links-heading" className="panel-card">
          <h2 id="links-heading">{msg('linksHeading')}</h2>
          {state.links !== null ? (
            <BookingGrid destination={state.links} />
          ) : (
            <p className="slot-empty">{msg('linksEmpty')}</p>
          )}
        </section>
      </section>
      <section
        id="settings-panel"
        role="tabpanel"
        aria-labelledby="tab-settings"
        hidden={selected('settings') ? undefined : true}
      >
        <section aria-labelledby="settings-heading" className="panel-card">
          <h2 id="settings-heading">{msg('settingsKeyHeading')}</h2>
          {state.showOrphaned ? <p className="key-notice">{msg('keyReenterNotice')}</p> : null}
          {!state.keySaved || state.replacing ? (
            <KeySetup
              mode="setup"
              pending={keyForm.pending}
              error={keyForm.error}
              sessionOnly={keyForm.sessionOnly}
              resetKey={keyForm.resetKey}
              callbacks={{
                onSave: (key) => void onKeySave(key),
                onError: (text) => setKeyForm({ error: text }),
                onSessionOnlyChange: (checked) => void onSessionOnlyChange(checked),
                onConsentDecision: (agreed) => void onConsentDecision(agreed),
              }}
            />
          ) : (
            <>
              <p id="key-saved-status">{msg('keySavedStatus')}</p>
              {keyForm.error === null ? null : <p id="key-saved-error">{keyForm.error}</p>}
              <div className="confirm-actions">
                <button type="button" onClick={() => store.set({ replacing: true })}>
                  {msg('keyReplaceButton')}
                </button>
                <button type="button" onClick={() => onRemoveKey()}>
                  {msg('clearKeyButton')}
                </button>
              </div>
            </>
          )}
        </section>
        <section aria-labelledby="modes-heading" className="panel-card">
          <ModesSection
            key={state.panelSettings.loaded ? 'modes-ready' : 'modes-loading'}
            heading={msg('settingsModesHeading')}
            imageOnly={state.panelSettings.imageOnly}
            skipWebSearch={state.panelSettings.skipWebSearch}
          />
        </section>
        <section aria-labelledby="settings-cost-heading" className="panel-card">
          <CostSection
            heading={msg('costHeading')}
            headingId="settings-cost-heading"
            lineId="settings-cost-line"
            costText={state.panelSettings.costText}
            runText={state.cost}
            runLineId="settings-run-line"
          />
        </section>
      </section>
      <footer id="page-footer">
        <p id="privacy-line">{state.privacy}</p>
      </footer>
    </main>
  );
};

const renderCrashFallback = (reset: () => void) => (
  <main>
    <h2
      tabIndex={-1}
      ref={(el) => {
        el?.focus();
      }}
    >
      {msg('errorServerTitle')}
    </h2>
    <p>{msg('errorServerBody')}</p>
    <button
      type="button"
      onClick={() => {
        reset();
        void retry();
      }}
    >
      {msg('retryButton')}
    </button>
  </main>
);

const onPanelCrash = (): void => {
  cancelAllWork();
};

let panelRoot: Root | null = null;

export const unmountPage = (): void => {
  panelRoot?.unmount();
  panelRoot = null;
};

export const initPanel = (): void => {
  if (initialized) {
    return;
  }
  const host = document.getElementById('root');
  if (!host) {
    return;
  }
  initialized = true;
  panelRoot = createRoot(host);
  const root = panelRoot;
  flushSync(() => {
    root.render(
      <ErrorBoundary fallback={renderCrashFallback} onCatch={onPanelCrash}>
        <SidepanelApp />
      </ErrorBoundary>
    );
  });

  updatePreview(null);
  showIdle();
  void refreshLock();
  chrome.storage.local.onChanged.addListener(onLockAreaChanged);
  chrome.storage.session.onChanged.addListener(onLockAreaChanged);

  void refreshPanelSettings();
  void watchOwnHandoffSlot();
};

const watchOwnHandoffSlot = async (): Promise<void> => {
  const windowId = await getPanelWindowId();

  if (windowId === undefined) {
    return;
  }

  const slot = handoffSlotKey(windowId);
  chrome.storage.session.onChanged.addListener((changes) => {
    const change = changes[slot];
    if (change) {
      void handle(change.newValue);
    }
  });

  try {
    const stored = (await chrome.storage.session.get(slot)) as Record<string, unknown>;
    const initial = stored[slot];
    if (initial !== undefined) {
      void handle(initial);
    }
  } catch {
    // Startup delivery is best-effort; the next click delivers live.
  }
};

if (typeof document !== 'undefined') {
  initPanel();
}
