// Panel state machine: handoff intake, key and consent gates, cached or live
// analysis with streamed guides, disagree flows, and the cost footer.
import { useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BookingGrid } from './components/booking_grid/booking_grid';
import { CompareTable, type DuelTableState } from './components/compare_table/compare_table';
import type { ScanItemView } from './components/scan_list/scan_list';
import { ScanList } from './components/scan_list/scan_list';
import type {
  AlternateCardView,
  AlternatesView,
  CardState,
  CompareOptionView,
  PlanState,
} from './components/trip_card/trip_card';
import { TripCard } from './components/trip_card/trip_card';
import { KeySetup } from './components/key_setup/key_setup';
import { SourceChips } from './components/source_chips/source_chips';
import type { BoardItemView, TripRemovePinDetail } from './components/trip_board/trip_board';
import { TripBoard } from './components/trip_board/trip_board';
import { ProviderSection } from './components/settings/provider_section';
import { ModesSection } from './components/settings/modes_section';
import { DataSection } from './components/settings/data_section';
import { CostSection } from './components/settings/cost_section';
import {
  EMPTY_COMPAT_FORM,
  attachSettingsInputs,
  clearResultCache,
  compatErrorKey,
  saveCompatProvider,
  setCacheTtlDays,
  setMode,
  switchToClaude,
  type CompatFormValues,
} from './settings_ops';
import { prefersReducedMotion } from './utils/dom';
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
import {
  dataUrlToBytes,
  downscaleToJpegDataUrl,
  fetchImageBytes,
  fetchImageBytesViaTab,
} from './image_fetch';
import { clearAllKeys, clearKey, isVaultKey, loadKey, saveKey, setKeyMode } from './key_vault';
import { cropToSamBox, parseSamBoxes, selectSamBox, type SamPixelBox } from './sam';
import {
  estimateCachedSavingUsd,
  estimateCostUsd,
  formatUsd,
  readMonthSpend,
  resetMonthSpend,
} from './pricing';
import { createGuideRenderer, findGuideStart } from './render_markdown';
import {
  GUIDE_MAX_TEXT_CHARS,
  TRIP_REQUEST_SCHEMA,
  type ItineraryPlan,
  type PageSignals,
  type PlaceAlternate,
  type PlaceResult,
  type ScannedImage,
  type ScannedPlace,
  type TripRequest,
} from './types';
import { frameCacheSeed, hasVideoConsented, isMp4RungUsable, setVideoConsented } from './video';
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
  customHostOf,
  formatSignalsForPrompt,
  getActiveProvider,
  hasConsented,
  loadSettings,
  saveSettings,
  setConsented,
  SETTINGS_STORAGE_KEY,
  sanitizePromptHint,
  type AlternateIntent,
  type DuelSide,
  type ExtensionSettings,
  type GuideSource,
  type Provider,
  type Usage,
} from './providers/index';
import {
  getCacheEntry,
  hashGuideKey,
  hashIdentifyKey,
  isAllowedPreviewUrl,
  normalizeEndpoint,
  setCacheEntry,
  type CacheEntry,
} from './result_cache';
import { ErrorBoundary } from './components/error_boundary/error_boundary';
import { msg } from './utils/i18n';
import { dirForLanguage, truncateCodePoints } from './utils/text';
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

type PendingRun =
  | { kind: 'request'; request: TripRequest }
  | { kind: 'scan-guide'; request: TripRequest; index: number }
  | { kind: 'guide' }
  | { kind: 'itinerary' };

let initialized = false;

let scanPlaces: ScannedPlace[] = [];

let scanThumbs: Array<string | null> = [];

let currentCompareOptions: BoardPin[] = [];

let currentAlternates: { intent: AlternateIntent; alternatives: PlaceAlternate[] } | null = null;

let alternatesLoading: AlternateIntent | null = null;

let lastDuel: { a: DuelSide; b: DuelSide; aTitle: string; bTitle: string } | null = null;

let duelRunId = 0;

let alternatesRunId = 0;

let duelController: AbortController | null = null;

let alternatesController: AbortController | null = null;

let failedPin: Omit<BoardPin, 'addedAt'> | null = null;

let failedRemove: TripRemovePinDetail | null = null;

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
  scan: { loading: boolean; items: ScanItemView[] } | null;
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
  providerMuse: boolean;
  compatOpen: boolean;
  compat: CompatFormValues;
  compatError: string | null;
  compatConfirmHost: string | null;
  cacheTtlDays: number;
  cachePending: boolean;
  cacheResult: string | null;
  costText: string;
}

interface PanelState {
  tab: 'main' | 'board' | 'settings';
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
  guideVisible: boolean;
  guideBusy: boolean;
  searching: boolean;
  sources: GuideSource[];
  duel: DuelTableState | null;
  boardItems: BoardItemView[];
  boardCanPlan: boolean;
  boardNotice: { text: string | null; retryLabel: string | null };
  privacy: string;
  cost: string;
  customHost: string | null;
  keyForm: KeyFormState;
}

const blankResultSlot = (): ResultSlotState => ({
  card: null,
  scan: null,
  consent: false,
  video: null,
});

const store = createStore<PanelState>({
  tab: 'main',
  panelSettings: {
    loaded: false,
    imageOnly: false,
    skipWebSearch: false,
    providerMuse: true,
    compatOpen: false,
    compat: EMPTY_COMPAT_FORM,
    compatError: null,
    compatConfirmHost: null,
    cacheTtlDays: 7,
    cachePending: false,
    cacheResult: null,
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
  guideVisible: false,
  guideBusy: false,
  searching: false,
  sources: [],
  duel: null,
  boardItems: [],
  boardCanPlan: false,
  boardNotice: { text: null, retryLabel: null },
  privacy: '',
  cost: '',
  customHost: null,
  keyForm: {
    pending: false,
    error: null,
    sessionOnly: false,
    resetKey: 0,
  },
});

type PanelTab = 'main' | 'board' | 'settings';

const TAB_IDS: Record<PanelTab, string> = {
  main: 'tab-main',
  board: 'tab-board',
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

  const panel = active?.closest('#main-panel, #board-panel, #settings-panel');

  if (panel?.hasAttribute('hidden')) {
    document.getElementById(TAB_IDS[tab])?.focus();
  }
};

const enabledTabs = (): PanelTab[] => ['main', 'board', 'settings'];

let lockEpoch = 0;

const refreshLock = async (): Promise<void> => {
  const epoch = ++lockEpoch;

  try {
    const { provider, settings } = await getActiveProvider();

    const keyStatus = await loadKey(provider.id);

    if (epoch !== lockEpoch) {
      return;
    }

    store.set({
      keySaved: keyStatus.state === 'ok',
      customHost: customHostOf(settings),
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

const setPanelSettings = (patch: Partial<PanelSettingsState>): void => {
  store.set({ panelSettings: { ...store.get().panelSettings, ...patch } });
};

const settingsInputValue = (id: string): string =>
  (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';

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
        providerMuse: settings.activeProviderId !== 'openai_compat',
        compatOpen: prev.loaded ? prev.compatOpen : settings.activeProviderId === 'openai_compat',
        compat: {
          baseURL: settings.openaiCompat.baseURL,
          model: settings.openaiCompat.model,
          structured: settings.openaiCompat.structuredOutput,
          inputRate:
            settings.openaiCompat.inputRatePerM === undefined
              ? ''
              : String(settings.openaiCompat.inputRatePerM),
          outputRate:
            settings.openaiCompat.outputRatePerM === undefined
              ? ''
              : String(settings.openaiCompat.outputRatePerM),
          cachedRate:
            settings.openaiCompat.cachedRatePerM === undefined
              ? ''
              : String(settings.openaiCompat.cachedRatePerM),
        },
        cacheTtlDays: settings.cacheTtlDays,
        costText: msg('optionsCostMonth', formatUsd(spend)),
      },
    });
  } catch {
    // Keep the previous settings form on storage failure.
  }
};

const refreshPanelCost = async (): Promise<void> => {
  try {
    setPanelSettings({ costText: msg('optionsCostMonth', formatUsd(await readMonthSpend())) });
  } catch {
    setPanelSettings({ costText: msg('optionsCostMonth', formatUsd(0)) });
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

const onSettingsMuse = (box: HTMLInputElement): void => {
  void (async () => {
    try {
      await switchToClaude();
    } catch {
      box.checked = false;
      announceAlert('settingsSaveFailed');

      return;
    }

    setPanelSettings({ compatOpen: false, compatError: null, compatConfirmHost: null });
    announceStatus('statusProviderSaved');
    await refreshLock();
  })();
};

const onSettingsCompatSave = (): void => {
  void (async () => {
    setPanelSettings({ compatError: null });

    const outcome = await saveCompatProvider(
      {
        baseURL: settingsInputValue('compat-base-url'),
        model: settingsInputValue('compat-model'),
        structured: settingsInputValue('compat-structured'),
        inputRate: settingsInputValue('compat-input-rate'),
        outputRate: settingsInputValue('compat-output-rate'),
        cachedRate: settingsInputValue('compat-cached-rate'),
      },
      store.get().panelSettings.compatConfirmHost
    );

    if (outcome.status === 'saved') {
      setPanelSettings({ compatError: null, compatConfirmHost: null });
      announceStatus('statusProviderSaved');
      await refreshLock();

      return;
    }

    if (outcome.status === 'confirm') {
      setPanelSettings({
        compatError: msg('compatHostWarning', outcome.host),
        compatConfirmHost: outcome.host,
      });

      return;
    }

    setPanelSettings({ compatError: msg(compatErrorKey(outcome.error)) });
  })();
};

const onSettingsRetention = (days: number, select: HTMLSelectElement): void => {
  const current = store.get().panelSettings.cacheTtlDays;

  if (days !== 1 && days !== 7 && days !== 30) {
    select.value = String(current);

    return;
  }

  void (async () => {
    try {
      await setCacheTtlDays(days as 1 | 7 | 30);
    } catch {
      select.value = String(current);
      announceAlert('settingsSaveFailed');

      return;
    }

    setPanelSettings({ cacheTtlDays: days });
  })();
};

const onSettingsClearCache = (): void => {
  void (async () => {
    setPanelSettings({ cachePending: true, cacheResult: null });

    let cleared = 0;

    try {
      cleared = await clearResultCache();
    } catch {
      setPanelSettings({ cachePending: false, cacheResult: msg('cacheClearFailed') });

      return;
    }

    const result =
      cleared === 0
        ? msg('cacheClearedNone')
        : cleared === 1
          ? msg('cacheClearedOne')
          : msg('cacheClearedMany', String(cleared));

    setPanelSettings({ cachePending: false, cacheResult: result });
  })();
};

const onSettingsResetCost = (): void => {
  void (async () => {
    try {
      await resetMonthSpend();
    } catch {
      announceAlert('settingsSaveFailed');

      return;
    }

    await refreshPanelCost();
    announceStatus('statusMonthlyReset');
  })();
};

const attachPanelSettings = (el: HTMLElement | null): (() => void) | void => {
  if (!el) {
    return;
  }

  return attachSettingsInputs(el, {
    onMode: onSettingsMode,
    onMuse: onSettingsMuse,
    onCompat: () => {
      setPanelSettings({ compatOpen: true });
    },
    onRetention: onSettingsRetention,
  });
};

const guideContentEl = (): HTMLElement | null => document.getElementById('guide-content');

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

// Request behind the displayed result (or scan), for follow-up stages that
// must bind to what the user sees rather than to any live run.
let displayedRequestId: string | null = null;

let displayedRequest: TripRequest | null = null;

let runSettings: ExtensionSettings | null = null;

let pendingRun: PendingRun | null = null;

let lastRun: PendingRun | null = null;

let currentCacheKey = '';

let currentPlace: PlaceResult | null = null;

let currentDestination = '';

let currentView = '';

let shortcutText = '';

let skeletonTimer: ReturnType<typeof setTimeout> | undefined;

let skeletonFor = '';

let skeletonShownAt = 0;

let staleTimer: ReturnType<typeof setTimeout> | undefined;

let guidePlanning = false;

let currentPlanState: PlanState = 'idle';

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
  guideContentEl()?.replaceChildren();
  store.set({
    links: null,
    guideVisible: false,
    guideBusy: false,
    searching: false,
    sources: [],
    duel: null,
  });
};

const showLinks = (destination: string): void => {
  store.set({ links: destination });
};

const showSources = (sources: GuideSource[]): void => {
  store.set({ sources: [...sources] });
};

type PrivacyMode =
  | 'image'
  | 'image-only'
  | 'image-pixels'
  | 'image-pixels-only'
  | 'scan'
  | 'cache'
  | 'idle'
  | 'video-frame'
  | 'video-frame-only'
  | 'video-url'
  | 'video-url-only'
  | 'board'
  | 'names';

const privacyDestination = (): string => {
  if (runSettings?.activeProviderId === 'openai_compat') {
    try {
      return new URL(runSettings.openaiCompat.baseURL).host || 'the custom server';
    } catch {
      return 'the custom server';
    }
  }

  return "Meta's Muse API";
};

const PRIVACY_KEYS: Record<PrivacyMode, string> = {
  image: 'privacyImage',
  'image-only': 'privacyImageOnly',
  'image-pixels': 'privacyImagePixels',
  'image-pixels-only': 'privacyImagePixelsOnly',
  scan: 'privacyScan',
  cache: 'privacyCache',
  idle: 'privacyIdle',
  'video-frame': 'privacyVideoFrame',
  'video-frame-only': 'privacyVideoFrameOnly',
  'video-url': 'privacyVideoUrl',
  'video-url-only': 'privacyVideoUrlOnly',
  board: 'privacyBoard',
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

  if (usd === null) {
    if (ownsUi(run)) {
      let monthTotal = 0;

      try {
        monthTotal = await readMonthSpend();
      } catch {
        // The total is stale; the incomplete flag still renders.
      }

      store.set({
        cost: run.costComplete
          ? msg('costLineTokens', [String(run.usage.inputTokens), String(run.usage.outputTokens)])
          : msg('costIncomplete', [formatUsd(monthTotal)]),
      });
    }

    return;
  }

  let monthTotal = usd;

  try {
    monthTotal = await settleStage(run, stage);
  } catch {
    // The run figure still renders; only the monthly total is stale.
  }

  if (!ownsUi(run)) {
    return;
  }

  if (!run.costComplete) {
    store.set({ cost: msg('costIncomplete', [formatUsd(monthTotal)]) });

    return;
  }

  const saved = rates ? estimateCachedSavingUsd(run.usage, rates) : 0;
  store.set({
    cost:
      saved > 0
        ? msg('costLineCached', [formatUsd(usd), formatUsd(monthTotal), formatUsd(saved)])
        : msg('costLine', [formatUsd(usd), formatUsd(monthTotal)]),
  });
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
      store.set({ result: { ...blankResultSlot(), card: { view: 'loading' } } });
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
    store.set({ result: { ...blankResultSlot(), scan: { loading: true, items: [] } } });
  });
};

const showIdle = (): void => {
  cancelSkeleton();
  currentView = 'idle';
  swapResultSlot(() => {
    store.set({
      result: {
        ...blankResultSlot(),
        card: { view: 'idle', hint: msg('panelIdle'), shortcut: shortcutText },
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

// Duel and alternates belong to the displayed result: a new analysis run
// aborts their controllers alongside the previous analysis. Ready alternate
// cards survive (their indices stay valid); only the in-flight marker
// resets, and the loser of a run race bows out by id.
const abortSiblings = (): void => {
  if (duelController) {
    duelController.abort();
    duelController = null;
  }
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
  displayedRequestId = run.requestId;
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
  isMp4RungUsable(request.srcUrl)
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

const renderResultHeader = async (
  run: RunContext,
  place: PlaceResult,
  announce: boolean,
  foundKey = 'statusFoundWriting'
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
    announceStatus(foundKey, place.placeName);
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
  fallback: { label: string; href: string } | null = null,
  showFetchRetry = false
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
          showFetchRetry,
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
  stream_error: ['errorStreamTitle', 'errorStreamBody', 'alertStreamError'],
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
  fetchRetryAvailable = false
): void => {
  const privacy = privacyOverride ?? errorPrivacy(request);
  // A 400 on the image-bearing identify means the model could not fetch
  // the remote image, so the card offers the byte-fetch retry.
  const fetchRetry =
    fetchRetryAvailable &&
    err instanceof ProviderError &&
    err.status === 400 &&
    !!request &&
    !request.mediaType &&
    !request.scanImages &&
    !request.dataPending &&
    (request.srcUrl.startsWith('https://') || isLoopbackHttp(request.srcUrl));
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
  if (err.code === 'not_configured') {
    pendingRun = request != null ? { kind: 'request', request } : pendingRun;
    renderErrorCard('errorServerTitle', 'alertNotConfigured', true, true);
    announceAlert('alertNotConfigured');
    updatePrivacy(privacy);
    return;
  }
  const [titleKey, bodyKey, alertKey] = ERROR_CARD_KEYS[err.code] ?? ERROR_CARD_FALLBACK;
  renderErrorCard(titleKey, bodyKey, true, false, null, fetchRetry);
  announceAlert(alertKey);
  updatePrivacy(privacy);
};

// Failures before any billable work (auth, missing key, consent, setup,
// caller aborts) carry no usage honestly: the run figure stays exact.
// Any other failure without usage means billed tokens went unreported,
// so the run stops claiming a complete cost.
const PRE_BILLING_CODES = new Set(['auth', 'no_key', 'consent_required', 'not_configured']);

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
    void priceAndRecord(run, stage);

    return;
  }

  if (err instanceof ProviderError && err.code === 'aborted') {
    void priceAndRecord(run, stage);

    return;
  }

  if (!(err instanceof ProviderError) || !PRE_BILLING_CODES.has(err.code)) {
    run.costComplete = false;
  }

  void priceAndRecord(run, stage);
};

interface GuideArgs {
  run: RunContext;
  privacy: PrivacyMode;
  origin: 'gesture' | 'panel';
  prompt?: string;
  completeKey?: string;
}

const showGuideSkeleton = (content: HTMLElement): void => {
  content.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'guide-skeleton';
  wrap.setAttribute('aria-hidden', 'true');
  for (const width of ['90%', '100%', '70%']) {
    const block = document.createElement('div');
    block.className = 'skeleton-block';
    block.style.width = width;
    wrap.append(block);
  }
  const line = document.createElement('p');
  line.className = 'guide-loading';
  line.textContent = msg('statusPlanningTrip');
  wrap.append(line);
  content.append(wrap);
};

// The network stream is consumed but never rendered live: deltas buffer
// until completion, then the guide renders once into its fixed box. The
// searching line and sources still arrive live; they own fixed slots.
const runGuide = async (args: GuideArgs): Promise<RunOutcome> => {
  const { run, privacy, origin } = args;
  const provider = run.provider;
  const content = guideContentEl();
  if (!content || !ownsUi(run)) {
    return 'error';
  }
  store.set({ guideVisible: true, guideBusy: true });
  showGuideSkeleton(content);
  let guideSource = '';
  const sources: GuideSource[] = [];
  let searchedWeb = false;
  try {
    const events = provider.streamGuide(run.key, {
      destination: run.destination,
      signal: run.signal,
      language: chrome.i18n.getUILanguage(),
      prompt: args.prompt,
      transport: run.settings.skipWebSearch === true ? 'chat' : undefined,
    });
    for await (const event of events) {
      if (event.type === 'delta') {
        if (guideSource.length < GUIDE_MAX_TEXT_CHARS) {
          guideSource += event.text.slice(0, GUIDE_MAX_TEXT_CHARS - guideSource.length);
        }
      } else if (event.type === 'searching') {
        searchedWeb = true;

        if (ownsUi(run)) {
          store.set({ searching: true });
          announceStatus('statusSearchingWeb');
        }
      } else if (event.type === 'sources') {
        sources.push(...event.sources);

        if (ownsUi(run)) {
          showSources(sources);
        }
      } else if (event.type === 'usage') {
        absorbRunUsage(run, event.usage);
      }
    }
  } catch (err) {
    store.set({ guideBusy: false, searching: false, resultBusy: false });
    if (err instanceof ProviderError && err.code === 'aborted') {
      // Streamed tokens were billed even though the run was cancelled.
      recordPartialUsage(run, 'guide', err);

      if (activeRun() !== null) {
        // Superseded: the incoming run owns every pixel now.
        return 'aborted';
      }

      // User-cancelled while owning the UI: keep partial text without
      // marking complete. Never cached; planning stays available.
      if (guideSource.trim()) {
        const start = findGuideStart(guideSource);
        const renderer = createGuideRenderer(content, msg('truncatedNotice'));
        renderer.push(start >= 0 ? guideSource.slice(start) : guideSource);
        renderer.finish();
        const notice = document.createElement('p');
        notice.className = 'guide-interrupted';
        notice.textContent = msg('guideInterrupted');
        content.append(notice);
      } else {
        content.replaceChildren();
      }

      updatePrivacy(privacy);
      announceStatus('statusCanceled');

      return 'aborted';
    }
    recordPartialUsage(run, 'guide', err);
    await priceAndRecord(run, 'guide');

    if (!ownsUi(run)) {
      return 'error';
    }

    if (guideSource.trim()) {
      // Keep what streamed: a partial guide with an interrupted notice
      // beats an error card. It is never cached as complete, and the
      // Plan button stays available for a full retry.
      const start = findGuideStart(guideSource);
      const finalText = start >= 0 ? guideSource.slice(start) : guideSource;
      const renderer = createGuideRenderer(content, msg('truncatedNotice'));
      renderer.push(finalText);
      renderer.finish();
      const notice = document.createElement('p');
      notice.className = 'guide-interrupted';
      notice.textContent = msg('guideInterrupted');
      content.append(notice);
      announceAlert('guideInterrupted');
      return 'partial';
    }
    content.replaceChildren();
    const notice = document.createElement('p');
    notice.className = 'guide-interrupted';
    notice.textContent = msg('guideInterrupted');
    content.append(notice);
    showProviderError(err, run.request, privacy);
    return 'error';
  }
  await priceAndRecord(run, 'guide');

  if (!ownsUi(run)) {
    // Settled but stale: no cache write, no render, no announcement.
    return 'aborted';
  }

  const start = findGuideStart(guideSource);
  // Degenerate stream with no heading: render everything rather than
  // dropping content the hold-back rule cannot place.
  const finalText = start >= 0 ? guideSource.slice(start) : guideSource;
  const renderer = createGuideRenderer(content, msg('truncatedNotice'));
  renderer.push(finalText);
  renderer.finish();
  guideSource = finalText;
  store.set({ guideBusy: false, searching: false, resultBusy: false });
  if (run.guideKey && run.place) {
    await setCacheEntry(run.guideKey, {
      place: run.place,
      guide: guideSource,
      sources: [...sources],
      usage: { ...run.usage },
      searchedWeb,
    });
  }
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
  return 'result';
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

    showProviderError(
      err,
      request,
      undefined,
      !request.mediaType && !request.scanImages && !request.frame
    );
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
    guide: '',
    sources: [],
    usage: { ...run.usage },
    searchedWeb: false,
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
  run.guideKey = await guideKeyFor(
    run.cacheKey,
    run.destination,
    run.settings.skipWebSearch !== true
  );

  const guided = await getCacheEntry(run.guideKey);

  if (!ownsUi(run)) {
    await priceAndRecord(run, 'identify');

    return 'aborted';
  }

  if (guided?.guide) {
    await renderSplitHit(run, identify.place, guided, origin, 'identify');

    if (!ownsUi(run)) {
      await priceAndRecord(run, 'identify');

      return 'aborted';
    }

    updatePrivacy(privacy);
    store.set({ resultBusy: false });

    return 'result';
  }
  currentPlanState = 'idle';
  commitDisplayed(run, 'result');
  await renderResultHeader(run, identify.place, true, 'statusFoundPlan');

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

// The "Plan a trip" button (and its retries): the guide never runs until
// the user asks. On retry the error card yields to a fresh result header.
const runGuidePlan = async (): Promise<void> => {
  if (guidePlanning || !currentPlace) {
    return;
  }
  // Snapshot the click-time display: the guide plans for the result the
  // user saw, even if a newer run lands while the gate is open.
  const place = currentPlace;
  const destination = currentDestination;
  const cacheKey = currentCacheKey;
  const requestId = displayedRequestId ?? '';
  const request = displayedRequest;
  const ticket = ++runTicket;
  const gate = await gateRun({ kind: 'guide' });

  if (ticket !== runTicket) {
    return;
  }

  if (!gate.ready) {
    announceGate(gate.reason);
    return;
  }
  const { provider, settings, key } = gate;
  guidePlanning = true;
  const run = startRun(
    {
      runId: nextRunId(`${requestId}-guide`),
      requestId,
      kind: 'guide',
      provider,
      settings,
      key,
      request,
      place,
      destination,
      cacheKey,
    },
    { inheritFrom: pickInherit(requestId, provider, key), abortSiblings }
  );
  lastRun = { kind: 'guide' };
  // A completed guide may already exist (finished in another tab, or kept
  // while the header errored): reuse it instead of streaming again.
  run.guideKey = run.cacheKey
    ? await guideKeyFor(run.cacheKey, destination, settings.skipWebSearch !== true)
    : '';

  if (!ownsUi(run)) {
    guidePlanning = false;
    return;
  }

  if (run.guideKey) {
    const guided = await getCacheEntry(run.guideKey);

    if (!ownsUi(run)) {
      guidePlanning = false;
      return;
    }

    if (guided?.guide) {
      guidePlanning = false;
      selectTab('main');
      await renderSplitHit(run, place, guided, 'panel', 'guide');

      if (!ownsUi(run)) {
        await priceAndRecord(run, 'guide');
      }

      return;
    }
  }
  currentPlanState = 'planning';
  if (currentView !== 'result') {
    commitDisplayed(run, 'result');
    await renderResultHeader(run, place, false);
  } else {
    await refreshResultCard();
  }

  if (!ownsUi(run)) {
    guidePlanning = false;
    return;
  }

  selectTab('main');
  showSources([]);
  announceStatus('statusPlanningTrip');
  const privacy = run.request ? privacyForRequest(run.request, settings, provider) : 'image';
  let outcome: RunOutcome = 'error';
  try {
    outcome = await runGuide({ run, privacy, origin: 'panel' });
  } finally {
    guidePlanning = false;
  }

  if (!ownsUi(run)) {
    return;
  }

  if (outcome === 'result') {
    currentPlanState = 'ready';
    await refreshResultCard();
  } else if (outcome === 'partial') {
    currentPlanState = 'interrupted';
    await refreshResultCard();
  } else if (outcome === 'error') {
    currentPlanState = 'idle';
  }
};

const identifyKeyFor = async (run: RunContext, mediaSeed: string): Promise<string> =>
  hashIdentifyKey({
    mediaSeed,
    pageUrl: run.request?.pageUrl ?? '',
    providerId: run.provider.id,
    endpoint: normalizeEndpoint(run.provider.id, run.settings.openaiCompat.baseURL),
    model: run.provider.modelName,
    imageOnly: run.settings.imageOnly,
  });

const guideKeyFor = async (
  identifyKey: string,
  destination: string,
  grounded: boolean
): Promise<string> => hashGuideKey(identifyKey, destination, chrome.i18n.getUILanguage(), grounded);

// Split cache read: the identify entry carries the place, the guide entry
// (keyed off the identify hash plus destination, language, and grounding)
// carries a completed guide. Either may hit independently.
const readSplitCache = async (run: RunContext): Promise<CacheEntry | undefined> => {
  const placeEntry = await getCacheEntry(run.cacheKey);

  if (!placeEntry || !placeEntry.place.identified) {
    return placeEntry;
  }

  run.guideKey = await guideKeyFor(
    run.cacheKey,
    buildDestination(placeEntry.place.placeName, placeEntry.place.city, placeEntry.place.country),
    run.settings.skipWebSearch !== true
  );

  const guided = await getCacheEntry(run.guideKey);

  return {
    ...placeEntry,
    guide: guided?.guide ?? '',
    sources: guided?.sources ?? [],
    searchedWeb: guided?.searchedWeb ?? false,
  };
};

const paintCachedGuide = (guide: string, sources: GuideSource[]): void => {
  const content = guideContentEl();
  if (content && guide) {
    const renderer = createGuideRenderer(content, msg('truncatedNotice'));
    renderer.push(guide);
    renderer.finish();
    store.set({ guideVisible: true });
  } else {
    store.set({ guideVisible: false });
  }
  if (sources.length > 0) {
    showSources(sources);
  } else {
    store.set({ sources: [] });
  }
};

// A completed guide reused without a new request: full result paint plus
// an honest cost re-render, since the run may have paid for fresh work.
const renderSplitHit = async (
  run: RunContext,
  place: PlaceResult,
  guided: CacheEntry,
  origin: 'gesture' | 'panel',
  stage: string
): Promise<void> => {
  currentPlanState = 'ready';
  commitDisplayed(run, 'result');
  await renderResultHeader(run, place, false);

  if (!ownsUi(run)) {
    return;
  }

  paintCachedGuide(guided.guide, guided.sources);
  await priceAndRecord(run, stage);

  if (!ownsUi(run)) {
    return;
  }

  if (guided.sources.length > 0) {
    announceStatus('statusGuideReadySources', String(guided.sources.length));
  } else {
    announceStatus('statusGuideReady');
  }
  if (origin === 'panel') {
    focusResultHeading();
  }
};

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
  if (!entry.place.identified) {
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
    store.set({ cost: msg('costLineCache') });
    updatePrivacy('cache');
    announceStatus('statusNoPlace');
    if (origin === 'panel') {
      focusResultHeading();
    }
    return;
  }
  run.destination = buildDestination(entry.place.placeName, entry.place.city, entry.place.country);
  currentAlternates = null;
  currentPlanState = entry.guide ? 'ready' : 'idle';
  commitDisplayed(run, 'result');
  const props = await resultCardProps(entry.place);

  if (!ownsUi(run)) {
    return;
  }

  swapResultSlot(() => {
    store.set({ result: { ...blankResultSlot(), card: props } });
  });
  showLinks(currentDestination);
  paintCachedGuide(entry.guide, entry.sources);
  setPreviewIdentified(entry.place.placeName);
  store.set({ cost: msg('costLineCache') });
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

  const cached = await readSplitCache(run);

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
  showSkeleton(request.requestId);
  await runIdentify({ run, origin });
};

// ---- Page scan ----

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

const scanItemViews = async (
  places: ScannedPlace[],
  thumbs: Array<string | null>
): Promise<ScanItemView[]> => {
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

const runScan = async (run: RunContext, origin: 'gesture' | 'panel'): Promise<void> => {
  const request = run.request;

  if (!request) {
    return;
  }

  const images = request.scanImages ?? [];
  const privacy: PrivacyMode = 'scan';
  if (images.length === 0) {
    renderErrorCard('scanEmptyTitle', 'scanEmptyBody', false, false);
    announceAlert('scanEmptyBody');
    updatePrivacy('idle');
    return;
  }
  showScanSkeleton();
  announceStatus('statusAnalyzing');
  let result;
  try {
    result = await run.provider.scanPlaces(run.key, { images, signal: run.signal });
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'aborted') {
      recordPartialUsage(run, 'scan', err);

      if (activeRun() !== null) {
        return;
      }

      cancelSkeleton();
      showIdle();
      announceStatus('statusCanceled');

      return;
    }
    recordPartialUsage(run, 'scan', err);
    await priceAndRecord(run, 'scan');

    if (!ownsUi(run)) {
      return;
    }

    showProviderError(err, request, privacy);
    return;
  }
  absorbRunUsage(run, result.usage);

  if (!ownsUi(run)) {
    await priceAndRecord(run, 'scan');

    return;
  }

  if (result.places.length === 0) {
    await priceAndRecord(run, 'scan');

    if (!ownsUi(run)) {
      return;
    }

    updatePrivacy(privacy);
    renderErrorCard('scanNoneTitle', 'scanNoneBody', false, false);
    announceAlert('scanNoneBody');
    return;
  }
  scanPlaces = result.places;
  scanThumbs = result.places.map((place) => pairScanThumb(place, images));
  const views = await scanItemViews(scanPlaces, scanThumbs);

  if (!ownsUi(run)) {
    return;
  }

  commitDisplayed(run, 'scan');
  swapResultSlot(() => {
    store.set({ result: { ...blankResultSlot(), scan: { loading: false, items: views } } });
  });
  await priceAndRecord(run, 'scan');

  if (!ownsUi(run)) {
    return;
  }

  updatePrivacy(privacy);
  announceStatus('scanFound', String(scanPlaces.length));
  if (origin === 'panel') {
    document.getElementById('scan-heading')?.focus();
  }
};

const runScanGuide = async (
  request: TripRequest,
  index: number,
  origin: 'gesture' | 'panel'
): Promise<void> => {
  const place = scanPlaces[index];
  if (!place) {
    return;
  }
  const ticket = ++runTicket;
  cancelAllWork();
  clearStaleTimer();
  lastRun = { kind: 'scan-guide', request, index };
  pendingRun = null;
  const result = scanPlaceResult(place);
  const thumb = scanThumbs[index] ?? null;
  updatePreview(thumb);
  clearCost();
  const gate = await gateRun({ kind: 'scan-guide', request, index });

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
      runId: nextRunId(`${request.requestId}-guide-${index}`),
      requestId: request.requestId,
      kind: 'scan-guide',
      provider,
      settings,
      key,
      request,
      place: result,
    },
    { inheritFrom: pickInherit(request.requestId, provider, key), abortSiblings }
  );
  const privacy: PrivacyMode = settings.imageOnly ? 'image-only' : 'image';
  run.cacheKey = await identifyKeyFor(run, thumb ?? `scan:${result.placeName},${result.country}`);

  if (!ownsUi(run)) {
    return;
  }

  const cached = await readSplitCache(run);

  if (!ownsUi(run)) {
    return;
  }

  if (cached) {
    await renderCached(run, cached, origin);
    return;
  }
  // The scan already identified the place: stream the guide for the known
  // destination with no second identify pass.
  run.destination = buildDestination(result.placeName, result.city, result.country);
  await setCacheEntry(run.cacheKey, {
    place: result,
    guide: '',
    sources: [],
    usage: { ...run.usage },
    searchedWeb: false,
  });

  if (!ownsUi(run)) {
    return;
  }

  run.guideKey = await guideKeyFor(
    run.cacheKey,
    run.destination,
    run.settings.skipWebSearch !== true
  );

  const guided = await getCacheEntry(run.guideKey);

  if (!ownsUi(run)) {
    return;
  }

  if (guided?.guide) {
    await renderSplitHit(run, result, guided, origin, 'scan');
    return;
  }

  currentPlanState = 'planning';
  commitDisplayed(run, 'result');
  await renderResultHeader(run, result, true);

  if (!ownsUi(run)) {
    return;
  }

  const outcome = await runGuide({ run, privacy, origin });

  if (!ownsUi(run)) {
    return;
  }

  currentPlanState =
    outcome === 'result' ? 'ready' : outcome === 'partial' ? 'interrupted' : 'idle';
  if (outcome === 'result' || outcome === 'partial') {
    await refreshResultCard();
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
    sourceHost: sourceHostFor(displayedRequest),
    ...(thumb ? { imageUrl: thumb } : {}),
  };
};

const refreshScanPins = async (): Promise<void> => {
  if (currentView !== 'scan') {
    return;
  }
  store.set({
    result: {
      ...blankResultSlot(),
      scan: { loading: false, items: await scanItemViews(scanPlaces, scanThumbs) },
    },
  });
};

const onScanGuide = async (index: number): Promise<void> => {
  const request = displayedRequest;
  if (!request) {
    return;
  }
  await runScanGuide(request, index, 'panel');
};

const onScanPin = async (index: number): Promise<void> => {
  const pin = scanPinFor(index);
  if (!pin) {
    return;
  }
  await attemptPin(pin);
  await refreshScanPins();
};

const onScanPinSelected = async (indices: number[]): Promise<void> => {
  for (const index of indices) {
    const pin = scanPinFor(index);
    if (pin) {
      await attemptPin(pin);
    }
  }
  await refreshScanPins();
};

const runAnalysis = async (request: TripRequest, origin: 'gesture' | 'panel'): Promise<void> => {
  const superseded = activeRun() !== null;
  const ticket = ++runTicket;
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
      kind:
        request.scanImages !== undefined
          ? 'scan'
          : request.mediaType === 'video'
            ? 'video'
            : 'identify',
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
  if (request.scanImages !== undefined) {
    await runScan(run, origin);
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

  const cached = await readSplitCache(run);

  if (!ownsUi(run)) {
    return;
  }

  if (cached) {
    await renderCached(run, cached, origin);
    return;
  }
  announceStatus(superseded ? 'statusCanceledNew' : 'statusAnalyzing');
  showSkeleton(request.requestId);
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
    if (request.scanImages !== undefined) {
      showScanSkeleton();
    } else {
      showSkeleton(request.requestId);
    }
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
    // instead of stranding the panel on a skeleton.
    store.set({ guideBusy: false, searching: false, resultBusy: false });
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
    if (
      request.mediaType ||
      request.scanImages ||
      (!request.srcUrl.startsWith('https://') && !loopback)
    ) {
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
  lookAgainUsed.add(cacheKey);
  store.set({ resultBusy: true });
  announceStatus('statusAnalyzing');
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
    let samCrop: SamCrop | null = null;
    if (provider.capabilities.segmentation) {
      samCrop = await trySamCrop(run, request);

      if (!ownsUi(run)) {
        return;
      }
    }
    const identifyRequest =
      samCrop && request.frame
        ? { ...request, frame: { ...request.frame, dataUrl: samCrop.dataUrl } }
        : samCrop
          ? { ...request, srcUrl: samCrop.dataUrl }
          : request;
    await runIdentify({ run, origin: 'panel', rejectedPlace, requestOverride: identifyRequest });
  } finally {
    store.set({ resultBusy: false });
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
    await runIdentify({ run, origin: 'panel', rejectedPlace });
  } finally {
    store.set({ resultBusy: false });
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
  } else if (target.kind === 'guide') {
    await runGuidePlan();
  } else {
    await runAnalysis(target.request, 'panel');
  }
};

// The model could not fetch the remote image, so the panel downloads the
// bytes itself (per-origin grant, credentials omitted) and retries with a
// data: URL. The grant is removed in the finally so it never outlives the
// click.
const fetchRetry = async (): Promise<void> => {
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
    target.scanImages ||
    target.dataPending ||
    (!srcUrl.startsWith('https://') && !loopback)
  ) {
    return;
  }
  let origin: string;
  try {
    origin = new URL(srcUrl).origin;
  } catch {
    return;
  }
  const controller = new AbortController();
  const runWithBytes = async (bytes: Uint8Array): Promise<void> => {
    const dataUrl = await downscaleToJpegDataUrl(bytes);
    if (!controller.signal.aborted) {
      await runAnalysis({ ...target, srcUrl: dataUrl, dataPending: false }, 'panel');
    }
  };
  // Prompt-free first: fetch inside the page tab, where CORS-open image
  // hosts need no extension permission. The attempt is fast, so the click
  // gesture usually survives for the fallback prompt below.
  try {
    const bytes = await fetchImageBytesViaTab(
      target.tabId,
      target.frameId ?? 0,
      srcUrl,
      controller.signal
    );
    cancelAllWork();
    clearStaleTimer();
    announceStatus('statusAnalyzing');
    try {
      await runWithBytes(bytes);
    } catch {
      if (!controller.signal.aborted) {
        announceAlert('fetchFailed');
      }
    }
    return;
  } catch {
    if (controller.signal.aborted) {
      return;
    }
    // The tab is gone, unscriptable, or the host rejects page fetches:
    // fall through to the permission-gated direct fetch.
  }
  const outcome = await withTempGrant(origin, loopback, async () => {
    cancelAllWork();
    clearStaleTimer();
    announceStatus('statusAnalyzing');
    try {
      await runWithBytes(await fetchImageBytes(srcUrl, controller.signal));
    } catch {
      if (!controller.signal.aborted) {
        announceAlert('fetchFailed');
      }
    }
  });
  if (!outcome.granted) {
    announceAlert('fetchDenied');
  }
};

// ---- Destination duel + alternates ----

const FINDING_KEYS: Record<AlternateIntent, string> = {
  cheaper: 'alternatesFindingCheaper',
  quieter: 'alternatesFindingQuieter',
  similar: 'alternatesFindingSimilar',
};

const alternatePlaceResult = (alt: PlaceAlternate): PlaceResult => ({
  identified: true,
  placeName: alt.placeName,
  city: '',
  country: alt.country,
  confidence: 0,
  oneLiner: alt.why,
});

const alternatesView = async (): Promise<AlternatesView> => {
  if (alternatesLoading) {
    return { state: 'loading', intent: alternatesLoading };
  }
  if (currentAlternates) {
    const cards: AlternateCardView[] = [];
    for (const alt of currentAlternates.alternatives) {
      cards.push({
        name: buildDestination(alt.placeName, '', alt.country),
        why: alt.why,
        bestMonth: alt.bestMonth,
        pinned: await isPlacePinned(alternatePlaceResult(alt)),
      });
    }
    return { state: 'ready', intent: currentAlternates.intent, cards };
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
  place: PlaceResult
): Promise<{
  view: 'result';
  place: PlaceResult;
  lowConfidence: boolean;
  pinned: boolean;
  planState: PlanState;
  canReanalyze: boolean;
  compareOptions: CompareOptionView[];
  alternates: AlternatesView;
}> => ({
  view: 'result',
  place,
  lowConfidence: place.confidence < 0.6,
  pinned: await isPlacePinned(place),
  planState: currentPlanState,
  canReanalyze: (displayedRequest?.srcUrl ?? '') !== '',
  compareOptions: await compareOptionViews(place),
  alternates: await alternatesView(),
});

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

const runDuel = async (a: DuelSide, b: DuelSide, aTitle: string, bTitle: string): Promise<void> => {
  duelController?.abort();
  const controller = new AbortController();
  duelController = controller;
  duelRunId += 1;
  const mine = duelRunId;
  lastDuel = { a, b, aTitle, bTitle };
  // The duel settles into the displayed run when it is still live, so the
  // cost figure stays cumulative; a detached duel settles silently.
  const host = activeRun();
  const gate = await gateRun(null);
  if (!gate.ready) {
    if (mine === duelRunId && (!host || activeRun() === host)) {
      announceGate(gate.reason);
    }
    return;
  }
  if (host && activeRun() !== host) {
    return;
  }
  const { provider, key, settings } = gate;
  const bucket = host ?? createEphemeralRun('duel', provider, settings, key);
  store.set({ duel: { mode: 'loading', a: aTitle, b: bTitle } });
  announceStatus('duelStatus', [a.name, b.name]);
  let result;
  try {
    result = await provider.duelPlaces(key, {
      a,
      b,
      skipWebSearch: settings.skipWebSearch,
      signal: controller.signal,
    });
  } catch (err) {
    if (duelController === controller) {
      duelController = null;
    }
    if (err instanceof ProviderError && err.code === 'aborted') {
      return;
    }
    recordPartialUsage(bucket, 'duel', err);
    if (mine !== duelRunId || (host && activeRun() !== host)) {
      return;
    }
    updatePrivacy('names');
    store.set({ duel: { mode: 'error', a: aTitle, b: bTitle } });
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
  absorbRunUsage(bucket, result.usage);
  if (mine !== duelRunId || (host && activeRun() !== host)) {
    await priceAndRecord(bucket, 'duel');
    return;
  }
  showSources(result.sources);
  store.set({
    duel: { mode: 'ready', a: aTitle, b: bTitle, rows: result.criteria, verdict: result.verdict },
  });
  await priceAndRecord(bucket, 'duel');
  updatePrivacy('names');
  announceStatus('duelReady');
};

const onCompare = async (value: string): Promise<void> => {
  const snapshot = currentCompareOptions[Number(value)];
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
    pinDisplayName(pin)
  );
};

const onDuelRetry = async (): Promise<void> => {
  if (lastDuel) {
    await runDuel(lastDuel.a, lastDuel.b, lastDuel.aTitle, lastDuel.bTitle);
  }
};

const onDuelCancel = (): void => {
  duelRunId += 1;
  duelController?.abort();
  duelController = null;
  lastDuel = null;
  store.set({ duel: null });
  announceStatus('statusCanceled');
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
    recordPartialUsage(bucket, 'alternates', err);
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
    await priceAndRecord(bucket, 'alternates');
    return;
  }
  currentAlternates = { intent, alternatives: result.alternatives };
  alternatesLoading = null;
  await refreshResultCard();
  showSources(result.sources);
  await priceAndRecord(bucket, 'alternates');
  updatePrivacy('names');
  announceStatus('alternatesReady', String(result.alternatives.length));
};

const onAlternates = async (intent: AlternateIntent): Promise<void> => {
  await runAlternates(intent);
};

const onAlternatesCancel = (): void => {
  alternatesRunId += 1;
  alternatesController?.abort();
  alternatesController = null;
  alternatesLoading = null;
  void refreshResultCard();
  announceStatus('statusCanceled');
};

const onPinAlternate = async (index: number): Promise<void> => {
  const target = currentAlternates?.alternatives[index];
  if (!target) {
    return;
  }
  await attemptPin({
    place: alternatePlaceResult(target),
    sourceHost: sourceHostFor(displayedRequest),
  });
};

const onPlanInstead = async (index: number): Promise<void> => {
  const target = currentAlternates?.alternatives[index];
  if (!target || currentView !== 'result') {
    return;
  }
  // Model-produced destinations are sanitized before re-entering a prompt.
  const destination = sanitizePromptHint(buildDestination(target.placeName, '', target.country));
  if (!destination) {
    return;
  }
  const ticket = ++runTicket;
  const gate = await gateRun(null);

  if (ticket !== runTicket) {
    return;
  }

  if (!gate.ready) {
    announceGate(gate.reason);
    return;
  }
  const { provider, settings, key } = gate;
  clearStaleTimer();
  lastRun = { kind: 'guide' };
  const requestId = displayedRequestId ?? '';
  // The selected place replaces the displayed one completely: B's card,
  // guide, links, pin target, and comparison target, never A's.
  const place: PlaceResult = {
    identified: true,
    placeName: target.placeName,
    city: '',
    country: target.country,
    confidence: 1,
    oneLiner: target.why,
  };
  const run = startRun(
    {
      runId: nextRunId(`${requestId}-instead`),
      requestId,
      kind: 'guide',
      provider,
      settings,
      key,
      request: null,
      destination,
      place,
    },
    { inheritFrom: pickInherit(requestId, provider, key), abortSiblings }
  );
  // B never completes A's cache entry: a synthetic identify key seeds a
  // B-only guide entry, so a repeated Plan instead is served from cache.
  run.cacheKey = await identifyKeyFor(run, `instead:${destination}`);
  run.guideKey = await guideKeyFor(run.cacheKey, destination, settings.skipWebSearch !== true);
  commitDisplayed(run, 'result');
  currentAlternates = null;
  scanPlaces = [];
  scanThumbs = [];
  updatePreview(null);
  clearContentSlots();
  showLinks(destination);
  announceStatus('statusAnalyzing');
  currentPlanState = 'planning';
  await refreshResultCard();

  if (!ownsUi(run)) {
    return;
  }

  const cached = await getCacheEntry(run.guideKey);

  if (!ownsUi(run)) {
    return;
  }

  if (cached?.guide) {
    await renderSplitHit(run, place, cached, 'panel', 'guide');

    return;
  }

  const outcome = await runGuide({ run, privacy: 'names', origin: 'panel' });

  if (!ownsUi(run)) {
    return;
  }

  currentPlanState =
    outcome === 'result' ? 'ready' : outcome === 'partial' ? 'interrupted' : 'idle';
  if (outcome === 'result' || outcome === 'partial') {
    await refreshResultCard();
  }
};

// ---- Trip Board ----

const pinDisplayName = (pin: BoardPin): string =>
  buildDestination(pin.place.placeName, pin.place.city, pin.place.country);

const boardItemViews = (pins: BoardPin[]): BoardItemView[] =>
  pins.map((pin) => ({
    placeName: pin.place.placeName,
    country: pin.place.country,
    title: pinDisplayName(pin),
    host: pin.sourceHost,
    image:
      pin.thumbnail ?? (pin.imageUrl && isAllowedPreviewUrl(pin.imageUrl) ? pin.imageUrl : null),
  }));

const renderBoard = async (): Promise<BoardPin[]> => {
  const pins = await listPins();
  store.set({ boardItems: boardItemViews(pins), boardCanPlan: pins.length >= 2 });
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
    store.set({
      boardNotice: {
        text: msg('boardNoticePinFail', pin.place.placeName),
        retryLabel: msg('boardRetryNoThumb'),
      },
    });
    announceAlert('alertPinFail', pin.place.placeName);
    return;
  }
  failedPin = null;
  store.set({ boardNotice: { text: null, retryLabel: null } });
  if (outcome.status === 'duplicate') {
    await syncPinButton();
    announceStatus('statusPinDuplicate', pin.place.placeName);
    return;
  }
  store.set({
    boardItems: boardItemViews(outcome.pins),
    boardCanPlan: outcome.pins.length >= 2,
  });
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
  const frame = displayedRequest?.frame?.dataUrl;
  const src = displayedRequest?.srcUrl ?? '';
  const held = frame ?? (src.startsWith('data:image/') ? src : undefined);
  const thumbnail = held ? await makeThumbnail(held) : null;
  const pin: Omit<BoardPin, 'addedAt'> = {
    place,
    sourceHost: sourceHostFor(displayedRequest),
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
    store.set({
      boardNotice: {
        text: msg('boardNoticeRemoveFail', detail.placeName),
        retryLabel: msg('boardRetryRemove'),
      },
    });
    announceAlert('alertRemoveFail', detail.placeName);
    return;
  }
  failedRemove = null;
  store.set({ boardItems: boardItemViews(pins), boardCanPlan: pins.length >= 2 });
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
  store.set({ boardItems: [], boardCanPlan: false });
  await syncPinButton();
  focusSelector('#board-heading button');
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
          sanitizePromptHint(day.summary, 500)
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
    store.set({
      result: {
        ...blankResultSlot(),
        card: {
          view: 'itinerary',
          title: msg('itineraryTitle', String(stops.length)),
          stops,
          mapsUrl: mapsDirUrl(stops.map((stop) => stop.name)),
          mapsLabel: msg('mapsLink', String(stops.length)),
        },
      },
    });
  });
};

const planTrip = async (): Promise<void> => {
  const ticket = ++runTicket;
  cancelAllWork();
  clearStaleTimer();
  const itinId = `itinerary-${Date.now()}`;
  lastRun = { kind: 'itinerary' };
  pendingRun = null;
  clearCost();
  const gate = await gateRun({ kind: 'itinerary' });

  if (ticket !== runTicket) {
    return;
  }

  if (!gate.ready) {
    announceGate(gate.reason);
    return;
  }
  const { provider, settings, key } = gate;
  const pins = await listPins();

  if (ticket !== runTicket) {
    return;
  }

  if (pins.length < 2) {
    // The Plan button guards this, but the board may have changed underneath.
    store.set({ boardItems: boardItemViews(pins), boardCanPlan: false });
    return;
  }
  selectTab('main');
  clearContentSlots();
  announceStatus('statusPlanning', String(pins.length));
  showSkeleton(itinId);
  const run = startRun(
    {
      runId: nextRunId(itinId),
      requestId: itinId,
      kind: 'itinerary',
      provider,
      settings,
      key,
      request: null,
    },
    { abortSiblings }
  );
  let result;
  try {
    result = await provider.planItinerary(key, {
      pins: pins.map((pin) => ({
        name: pinDisplayName(pin),
        host: pin.sourceHost,
        thumbnail: pin.thumbnail,
      })),
      signal: run.signal,
    });
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'aborted') {
      recordPartialUsage(run, 'itinerary', err);

      if (activeRun() !== null) {
        return;
      }

      cancelSkeleton();
      showIdle();
      announceStatus('statusCanceled');

      return;
    }
    recordPartialUsage(run, 'itinerary', err);
    await priceAndRecord(run, 'itinerary');

    if (!ownsUi(run)) {
      return;
    }

    showProviderError(err, null, 'board');
    return;
  }
  absorbRunUsage(run, result.usage);
  await settleSkeleton();

  if (!ownsUi(run)) {
    await priceAndRecord(run, 'itinerary');

    return;
  }

  commitDisplayed(run, 'itinerary');
  renderItineraryCard(pins, result.plan);
  updatePrivacy('board');
  focusResultHeading();
  run.destination = result.plan.stops.join(', ');
  await runGuide({
    run,
    privacy: 'board',
    origin: 'panel',
    prompt: narrationPrompt(pins, result.plan),
    completeKey: 'statusItineraryReady',
  });
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
  } else if (pending.kind === 'guide') {
    await runGuidePlan();
  } else {
    await runAnalysis(pending.request, 'panel');
  }
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

const onRemoveAllKeys = (): void => {
  void (async () => {
    try {
      await clearAllKeys();
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
    store.set({
      result: {
        ...blankResultSlot(),
        card: { view: 'idle', hint: msg('panelIdle'), shortcut: text },
      },
    });
  }
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
    <main>
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
          id="tab-board"
          role="tab"
          aria-selected={selected('board')}
          aria-controls="board-panel"
          tabIndex={selected('board') ? 0 : -1}
          onClick={() => selectTab('board')}
        >
          {msg('boardTitle', String(state.boardItems.length))}
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
                onPin: () => void onPinToggle(),
                onPlanTrip: () => void runGuidePlan(),
                onReanalyze: () => void reanalyze(),
                onRetry: () => void retry(),
                onFetchRetry: () => void fetchRetry(),
                onLookAgain: () => void lookAgain(),
                onAlternates: (intent) => void onAlternates(intent),
                onCompare: (value) => void onCompare(value),
                onPinAlternate: (index) => void onPinAlternate(index),
                onPlanInstead: (index) => void onPlanInstead(index),
                onCancelAlternates: onAlternatesCancel,
              }}
            />
          ) : null}
          {state.result.scan ? (
            <ScanList
              loading={state.result.scan.loading}
              items={state.result.scan.items}
              onGuide={(index) => void onScanGuide(index)}
              onPin={(index) => void onScanPin(index)}
              onPinSelected={(indices) => void onScanPinSelected(indices)}
            />
          ) : null}
          {state.result.consent ? (
            <KeySetup
              mode="consent"
              pending={keyForm.pending}
              error={keyForm.error}
              sessionOnly={keyForm.sessionOnly}
              resetKey={keyForm.resetKey}
              customHost={state.customHost}
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
              <p>
                {state.customHost
                  ? msg('videoConfirmBodyCustom', state.customHost)
                  : msg('videoConfirmBody')}
              </p>
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
        <div id="links-slot" hidden={state.links === null || undefined}>
          <h2 id="booking-heading">{msg('bookingHeading')}</h2>
          {state.links !== null ? <BookingGrid destination={state.links} /> : null}
        </div>
        <div id="guide-slot" hidden={!state.guideVisible || undefined}>
          <h2 id="guide-heading">{msg('guideHeading')}</h2>
          <p id="search-line" hidden={!state.searching || undefined}>
            {state.searching ? msg('statusSearchingWeb') : null}
          </p>
          <div
            id="guide-content"
            lang={chrome.i18n.getUILanguage()}
            dir={dirForLanguage(chrome.i18n.getUILanguage())}
            tabIndex={0}
            role="region"
            aria-labelledby="guide-heading"
            aria-busy={state.guideBusy || undefined}
          />
        </div>
        <div id="duel-slot" hidden={state.duel === null || undefined}>
          {state.duel ? (
            <CompareTable
              table={state.duel}
              onRetry={() => void onDuelRetry()}
              onCancel={onDuelCancel}
            />
          ) : null}
        </div>
        <div id="sources-slot" hidden={state.sources.length === 0 || undefined}>
          <h2 id="sources-heading">{msg('sourcesHeading')}</h2>
          <SourceChips sources={state.sources} />
        </div>
      </section>
      <section
        id="board-panel"
        role="tabpanel"
        aria-labelledby="tab-board"
        hidden={selected('board') ? undefined : true}
      >
        <div id="board-slot">
          <TripBoard
            items={state.boardItems}
            canPlan={state.boardCanPlan}
            notice={state.boardNotice}
            onRemovePin={(detail) => void onRemovePin(detail)}
            onPlan={() => void planTrip()}
            onClearConfirm={() => void onClearConfirm()}
            onRetryPin={() => void onRetryPin()}
          />
        </div>
      </section>
      <section
        id="settings-panel"
        role="tabpanel"
        aria-labelledby="tab-settings"
        hidden={selected('settings') ? undefined : true}
        ref={attachPanelSettings}
      >
        <h2 id="settings-heading">{msg('settingsKeyHeading')}</h2>
        {state.showOrphaned ? <p className="key-notice">{msg('keyReenterNotice')}</p> : null}
        {!state.keySaved || state.replacing ? (
          <KeySetup
            mode="setup"
            pending={keyForm.pending}
            error={keyForm.error}
            sessionOnly={keyForm.sessionOnly}
            resetKey={keyForm.resetKey}
            customHost={state.customHost}
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
              <button type="button" onClick={() => onRemoveAllKeys()}>
                {msg('clearAllKeysButton')}
              </button>
            </div>
          </>
        )}
        <div
          key={state.panelSettings.loaded ? 'settings-ready' : 'settings-loading'}
          id="panel-settings-sections"
        >
          <ModesSection
            heading={msg('settingsModesHeading')}
            imageOnly={state.panelSettings.imageOnly}
            skipWebSearch={state.panelSettings.skipWebSearch}
          />
          <ProviderSection
            heading={msg('settingsProviderHeading')}
            ready={state.panelSettings.loaded}
            providerMuse={state.panelSettings.providerMuse}
            compatOpen={state.panelSettings.compatOpen}
            compat={state.panelSettings.compat}
            compatError={state.panelSettings.compatError}
            confirmHost={state.panelSettings.compatConfirmHost}
            onSave={onSettingsCompatSave}
          />
          <DataSection
            heading={msg('settingsDataHeading')}
            ttlDays={state.panelSettings.cacheTtlDays}
            cachePending={state.panelSettings.cachePending}
            cacheResult={state.panelSettings.cacheResult}
            onClearCache={onSettingsClearCache}
          />
          <CostSection
            heading={msg('settingsCostHeading')}
            headingId="settings-cost-heading"
            lineId="settings-cost-line"
            buttonId="settings-reset-cost"
            costText={state.panelSettings.costText}
            onReset={onSettingsResetCost}
          />
        </div>
      </section>
      <footer id="page-footer">
        <p id="privacy-line">{state.privacy}</p>
        <p id="cost-line">{state.cost}</p>
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

export const initPanel = (): void => {
  if (initialized) {
    return;
  }
  const host = document.getElementById('root');
  if (!host) {
    return;
  }
  initialized = true;

  document.title = msg('appName');
  flushSync(() => {
    createRoot(host).render(
      <ErrorBoundary fallback={renderCrashFallback} onCatch={onPanelCrash}>
        <SidepanelApp />
      </ErrorBoundary>
    );
  });

  updatePreview(null);
  showIdle();
  void loadShortcutLine();
  void renderBoard();
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
