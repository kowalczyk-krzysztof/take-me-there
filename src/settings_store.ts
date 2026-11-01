export const SETTINGS_STORAGE_KEY = 'settings';

export const SETTINGS_VERSION = 1;

export interface SettingsRecord {
  v: number;
  settings: Partial<ExtensionSettings>;
}

export const migrateSettings = async (): Promise<void> => {
  const stored = (await chrome.storage.local.get(SETTINGS_STORAGE_KEY)) as {
    settings?: unknown;
  };

  const raw = stored.settings;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'settings' in raw) {
    return;
  }

  const record: SettingsRecord = {
    v: SETTINGS_VERSION,
    settings: raw as Partial<ExtensionSettings>,
  };
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: record });
};

export interface ExtensionSettings {
  imageOnly: boolean;
  sessionOnly: boolean;
  skipWebSearch: boolean;
  cacheTtlDays: number;
}

export const CACHE_TTL_CHOICES = [1, 7, 30] as const;

export type CacheTtlDays = (typeof CACHE_TTL_CHOICES)[number];

export const DEFAULT_CACHE_TTL_DAYS: CacheTtlDays = 7;

const normalizeTtlDays = (value: unknown): CacheTtlDays =>
  value === 1 || value === 7 || value === 30 ? value : DEFAULT_CACHE_TTL_DAYS;

const DEFAULT_SETTINGS: ExtensionSettings = {
  imageOnly: false,
  sessionOnly: false,
  skipWebSearch: false,
  cacheTtlDays: DEFAULT_CACHE_TTL_DAYS,
};

const unwrapSettings = (raw: unknown): Partial<ExtensionSettings> => {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  if ('settings' in raw && (raw as Partial<SettingsRecord>).v === SETTINGS_VERSION) {
    const inner = (raw as SettingsRecord).settings;

    return inner && typeof inner === 'object' ? inner : {};
  }

  if ('settings' in raw) {
    return {};
  }

  return raw as Partial<ExtensionSettings>;
};

export interface SettingsRead {
  settings: ExtensionSettings;
  missing: boolean;
}

// Strict read: a missing record yields defaults, but a storage failure
// throws so a run gate can refuse instead of silently enabling defaults.
export const readSettingsStrict = async (): Promise<SettingsRead> => {
  const stored = (await chrome.storage.local.get(SETTINGS_STORAGE_KEY)) as {
    settings?: Partial<ExtensionSettings> | SettingsRecord;
  };

  if (stored.settings === undefined) {
    return { settings: structuredClone(DEFAULT_SETTINGS), missing: true };
  }

  const s = unwrapSettings(stored.settings);

  if (!s || typeof s !== 'object') {
    return { settings: structuredClone(DEFAULT_SETTINGS), missing: false };
  }

  return {
    settings: {
      imageOnly: s.imageOnly === true,
      sessionOnly: s.sessionOnly === true,
      skipWebSearch: s.skipWebSearch === true,
      cacheTtlDays: normalizeTtlDays(s.cacheTtlDays),
    },
    missing: false,
  };
};

export const loadSettings = async (): Promise<ExtensionSettings> => {
  try {
    return (await readSettingsStrict()).settings;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
};

export const writeSettingsRecord = async (settings: ExtensionSettings): Promise<void> => {
  const record: SettingsRecord = { v: SETTINGS_VERSION, settings };
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: record });
};

export interface SettingsSnapshot {
  settings: ExtensionSettings;
  failed: boolean;
}

type SettingsListener = (snapshot: SettingsSnapshot) => void;

const settingsListeners = new Set<SettingsListener>();

let settingsSnapshot: SettingsSnapshot | null = null;

let settingsSubscribed = false;

let settingsPullEpoch = 0;

const publishSettings = (): void => {
  const snapshot = settingsSnapshot;

  if (!snapshot) {
    return;
  }

  for (const listener of [...settingsListeners]) {
    listener(snapshot);
  }
};

const pullSettings = async (): Promise<void> => {
  const epoch = ++settingsPullEpoch;

  let snapshot: SettingsSnapshot;

  try {
    const read = await readSettingsStrict();

    snapshot = { settings: read.settings, failed: false };
  } catch {
    snapshot = {
      settings: settingsSnapshot?.settings ?? structuredClone(DEFAULT_SETTINGS),
      failed: true,
    };
  }

  if (epoch !== settingsPullEpoch) {
    return;
  }

  settingsSnapshot = snapshot;

  publishSettings();
};

const onSettingsChanged = (changes: Record<string, unknown>): void => {
  if (changes[SETTINGS_STORAGE_KEY] !== undefined) {
    void pullSettings();
  }
};

// Every open surface renders from this snapshot, so a mode flipped in one
// page appears in the others without a reload.
export const subscribeSettings = (listener: SettingsListener): (() => void) => {
  settingsListeners.add(listener);

  if (!settingsSubscribed) {
    settingsSubscribed = true;

    chrome.storage.local.onChanged.addListener(onSettingsChanged);

    void pullSettings();
  } else if (settingsSnapshot) {
    listener(settingsSnapshot);
  }

  return () => {
    settingsListeners.delete(listener);
  };
};

export const refreshSettings = async (): Promise<void> => {
  await pullSettings();
};
