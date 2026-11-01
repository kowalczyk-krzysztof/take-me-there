import { getActiveProvider, ProviderError, type ExtensionSettings } from './providers/index';
import { saveKey, setKeyMode } from './key_vault';
import { saveSettings } from './settings_store';

export type SaveKeyFailure = 'keyErrorRejected' | 'keyErrorNetwork' | 'keyErrorRetry';

export type SaveKeyOutcome =
  { ok: true; settings: ExtensionSettings } | { ok: false; failure: SaveKeyFailure };

// Shared so the test/save/settings writes can never drift between pages.
export const validateAndSaveKey = async (
  key: string,
  sessionOnly: boolean
): Promise<SaveKeyOutcome> => {
  const { provider, settings } = await getActiveProvider();

  try {
    await provider.testKey(key);
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'auth') {
      return { ok: false, failure: 'keyErrorRejected' };
    }

    if (err instanceof ProviderError && err.code === 'network') {
      return { ok: false, failure: 'keyErrorNetwork' };
    }

    return { ok: false, failure: 'keyErrorRetry' };
  }

  const next = { ...settings, sessionOnly };

  try {
    await saveKey(provider.id, key, sessionOnly);
    await saveSettings(next);
  } catch {
    return { ok: false, failure: 'keyErrorRetry' };
  }

  return { ok: true, settings: next };
};

export interface KeyModeOutcome {
  settings: ExtensionSettings;
  failed: boolean;
}

export const applyKeyMode = async (checked: boolean): Promise<KeyModeOutcome> => {
  const { provider, settings } = await getActiveProvider();

  try {
    const result = await setKeyMode(provider.id, checked);

    return {
      settings: { ...settings, sessionOnly: result.sessionOnly },
      failed: result.error !== undefined,
    };
  } catch {
    return { settings, failed: true };
  }
};
