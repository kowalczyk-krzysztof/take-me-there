import { sendCommand } from './storage_client';

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

export const loadSettings = async (): Promise<ExtensionSettings> => {
  try {
    const stored = (await chrome.storage.local.get(SETTINGS_STORAGE_KEY)) as {
      settings?: Partial<ExtensionSettings> | SettingsRecord;
    };

    const s = unwrapSettings(stored.settings);

    if (!s || typeof s !== 'object') {
      return structuredClone(DEFAULT_SETTINGS);
    }

    return {
      imageOnly: s.imageOnly === true,
      sessionOnly: s.sessionOnly === true,
      skipWebSearch: s.skipWebSearch === true,
      cacheTtlDays: normalizeTtlDays(s.cacheTtlDays),
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
};

export const writeSettingsRecord = async (settings: ExtensionSettings): Promise<void> => {
  const record: SettingsRecord = { v: SETTINGS_VERSION, settings };
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: record });
};

export const saveSettings = async (settings: ExtensionSettings): Promise<void> => {
  await sendCommand<void>({ kind: 'settings.save', settings });
};
