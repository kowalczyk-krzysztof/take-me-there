import { sendCommand } from './storage_client';

export const SETTINGS_STORAGE_KEY = 'settings';

export const SETTINGS_VERSION = 1;

export interface SettingsRecord {
  v: number;
  settings: Partial<ExtensionSettings>;
}

// idempotent: wraps legacy bare settings; versioned records and unreadable
// garbage are left untouched (reads already tolerate both).
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

export interface OpenAiCompatSettings {
  baseURL: string;
  model: string;
  structuredOutput: 'json_schema' | 'json_object';
  inputRatePerM?: number;
  outputRatePerM?: number;
}

export interface ExtensionSettings {
  activeProviderId: string;
  openaiCompat: OpenAiCompatSettings;
  imageOnly: boolean;
  sessionOnly: boolean;
  skipWebSearch: boolean;
}

const DEFAULT_SETTINGS: ExtensionSettings = {
  activeProviderId: 'muse',
  openaiCompat: { baseURL: '', model: '', structuredOutput: 'json_object' },
  imageOnly: false,
  sessionOnly: false,
  skipWebSearch: false,
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

    const compat =
      s.openaiCompat && typeof s.openaiCompat === 'object'
        ? (s.openaiCompat as Partial<OpenAiCompatSettings>)
        : {};

    return {
      activeProviderId: typeof s.activeProviderId === 'string' ? s.activeProviderId : 'muse',
      openaiCompat: {
        baseURL: typeof compat.baseURL === 'string' ? compat.baseURL : '',
        model: typeof compat.model === 'string' ? compat.model : '',
        structuredOutput: compat.structuredOutput === 'json_schema' ? 'json_schema' : 'json_object',
        ...(typeof compat.inputRatePerM === 'number'
          ? { inputRatePerM: compat.inputRatePerM }
          : {}),
        ...(typeof compat.outputRatePerM === 'number'
          ? { outputRatePerM: compat.outputRatePerM }
          : {}),
      },
      imageOnly: s.imageOnly === true,
      sessionOnly: s.sessionOnly === true,
      skipWebSearch: s.skipWebSearch === true,
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
