import type { ExtensionSettings } from './providers/index';

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
