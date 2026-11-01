import { getProvider, ProviderError, type ExtensionSettings } from './providers/index';
import { persistKey, setKeyMode } from './key_vault';

export type SaveKeyFailure = 'keyErrorRejected' | 'keyErrorNetwork' | 'keyErrorRetry';

export type SaveKeyOutcome =
  { ok: true; settings: ExtensionSettings } | { ok: false; failure: SaveKeyFailure };

// Shared so the test/save/settings writes can never drift between pages.
export const validateAndSaveKey = async (
  key: string,
  sessionOnly: boolean
): Promise<SaveKeyOutcome> => {
  const provider = getProvider();

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

  try {
    const settings = await persistKey(provider.id, key, sessionOnly);

    return { ok: true, settings };
  } catch {
    return { ok: false, failure: 'keyErrorRetry' };
  }
};

export interface KeyModeOutcome {
  sessionOnly: boolean;
  failed: boolean;
}

export const applyKeyMode = async (checked: boolean): Promise<KeyModeOutcome> => {
  const provider = getProvider();

  try {
    const result = await setKeyMode(provider.id, checked);

    return { sessionOnly: result.sessionOnly, failed: result.error !== undefined };
  } catch {
    return { sessionOnly: !checked, failed: true };
  }
};
