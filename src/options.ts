// Options page: key management around the shared key form, the image-only
// toggle, the AI provider switch with custom-server settings (Milestone 2),
// the monthly cost total with reset, and the privacy disclosure.
import './components/key_setup';
import type {
  KeySaveRequestDetail,
  KeySetupElement,
  SessionOnlyChangeDetail,
} from './components/key_setup';
import { adoptSharedStyles } from './components/shared_styles';
import { clearKey, loadKey, saveKey } from './key_vault';
import { formatUsd, readMonthSpend, resetMonthSpend } from './pricing';
import {
  ProviderError,
  getActiveProvider,
  loadSettings,
  saveSettings,
} from './providers/index';

const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);

const req = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`options shell is missing #${id}`);
  }
  return el as T;
};

let initialized = false;

export const initOptions = (): void => {
  if (initialized) {
    return;
  }
  if (!document.getElementById('key-host')) {
    return;
  }
  initialized = true;
  adoptSharedStyles(document);

  document.title = msg('appName');
  document.documentElement.lang = msg('@@ui_locale').replace('_', '-');
  document.documentElement.dir = msg('@@bidi_dir');
  req('title').textContent = msg('appName');
  req('key-heading').textContent = msg('optionsKeyHeading');
  req<HTMLButtonElement>('test-key').textContent = msg('testKeyButton');
  req<HTMLButtonElement>('clear-key').textContent = msg('clearKeyButton');
  req<HTMLButtonElement>('reset-cost').textContent = msg('resetCostButton');
  req('image-only-label').textContent = msg('imageOnlyLabel');
  req('prefer-on-device-label').textContent = msg('preferOnDeviceLabel');
  req('provider-heading').textContent = msg('optionsProviderHeading');
  req('provider-muse-label').textContent = msg('providerMuse');
  req('provider-compat-label').textContent = msg('providerCompat');
  req('compat-base-url-label').textContent = msg('compatBaseUrl');
  req('compat-model-label').textContent = msg('compatModel');
  req('compat-structured-label').textContent = msg('compatStructured');
  req('compat-structured-schema').textContent = msg('compatStructuredSchema');
  req('compat-structured-object').textContent = msg('compatStructuredObject');
  req('compat-input-rate-label').textContent = msg('compatInputRate');
  req('compat-output-rate-label').textContent = msg('compatOutputRate');
  req<HTMLButtonElement>('compat-save').textContent = msg('compatSave');
  req('cost-heading').textContent = msg('optionsCostHeading');
  req('privacy-heading').textContent = msg('optionsPrivacyHeading');
  req('privacy-body').textContent = msg('optionsPrivacyBody');
  const statusRegion = req('status-region');
  const costLine = req('cost-line');
  const imageOnlyBox = req<HTMLInputElement>('image-only');
  const museRadio = req<HTMLInputElement>('provider-muse');
  const compatRadio = req<HTMLInputElement>('provider-compat');
  const compatFields = req('compat-fields');
  const baseUrlInput = req<HTMLInputElement>('compat-base-url');
  const modelInput = req<HTMLInputElement>('compat-model');
  const structuredSelect = req<HTMLSelectElement>('compat-structured');
  const inputRateInput = req<HTMLInputElement>('compat-input-rate');
  const outputRateInput = req<HTMLInputElement>('compat-output-rate');
  const compatError = req('compat-error');

  const showCompatError = (key: string | null): void => {
    if (!key) {
      compatError.hidden = true;
      compatError.textContent = '';
      return;
    }
    compatError.hidden = false;
    compatError.textContent = msg(key);
  };

  const keySetup = document.createElement('key-setup') as KeySetupElement;
  req('key-host').append(keySetup);

  const refreshCost = async (): Promise<void> => {
    const total = await readMonthSpend();
    costLine.textContent = msg('optionsCostMonth', formatUsd(total));
  };

  void loadSettings().then((settings) => {
    keySetup.setSessionOnly(settings.sessionOnly);
    imageOnlyBox.checked = settings.imageOnly;
    req<HTMLInputElement>('prefer-on-device').checked = settings.preferOnDevice;
    const compatActive = settings.activeProviderId === 'openai_compat';
    museRadio.checked = !compatActive;
    compatRadio.checked = compatActive;
    compatFields.hidden = !compatActive;
    baseUrlInput.value = settings.openaiCompat.baseURL;
    modelInput.value = settings.openaiCompat.model;
    structuredSelect.value = settings.openaiCompat.structuredOutput;
    inputRateInput.value =
      settings.openaiCompat.inputRatePerM === undefined
        ? ''
        : String(settings.openaiCompat.inputRatePerM);
    outputRateInput.value =
      settings.openaiCompat.outputRatePerM === undefined
        ? ''
        : String(settings.openaiCompat.outputRatePerM);
  });
  void refreshCost().catch(() => {
    costLine.textContent = msg('optionsCostMonth', formatUsd(0));
  });

  keySetup.addEventListener('key-save-request', (event) => {
    const detail = (event as CustomEvent<KeySaveRequestDetail>).detail;
    void (async () => {
      keySetup.setPending(true);
      statusRegion.textContent = msg('statusValidatingKey');
      const { provider, settings } = await getActiveProvider();
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
        await saveSettings({ ...settings, sessionOnly: detail.sessionOnly });
      } catch {
        keySetup.setPending(false);
        keySetup.setError(msg('keyErrorRetry'));
        return;
      }
      keySetup.setPending(false);
      keySetup.clear();
      statusRegion.textContent = msg('statusKeySaved');
    })();
  });

  keySetup.addEventListener('session-only-change', (event) => {
    const detail = (event as CustomEvent<SessionOnlyChangeDetail>).detail;
    void (async () => {
      const { provider, settings } = await getActiveProvider();
      await saveSettings({ ...settings, sessionOnly: detail.checked });
      const loaded = await loadKey(provider.id);
      if (loaded.state === 'ok') {
        await saveKey(provider.id, loaded.key, detail.checked);
      }
    })().catch(() => {
      // Best effort; the checkbox state stays as the user set it.
    });
  });

  req<HTMLButtonElement>('test-key').addEventListener('click', () => {
    void (async () => {
      const { provider } = await getActiveProvider();
      const draft = keySetup.getDraft();
      let key = draft.key;
      if (!key) {
        const loaded = await loadKey(provider.id);
        key = loaded.state === 'ok' ? loaded.key : '';
      }
      if (!key) {
        keySetup.setError(msg('keyErrorEmpty'));
        return;
      }
      statusRegion.textContent = msg('statusValidatingKey');
      try {
        await provider.testKey(key);
      } catch (err) {
        if (err instanceof ProviderError && err.code === 'auth') {
          keySetup.setError(msg('keyErrorRejected'));
        } else {
          keySetup.setError(msg('keyErrorRetry'));
        }
        return;
      }
      statusRegion.textContent = msg('statusKeyWorks');
    })();
  });

  req<HTMLButtonElement>('clear-key').addEventListener('click', () => {
    void (async () => {
      const { provider } = await getActiveProvider();
      await clearKey(provider.id);
      keySetup.clear();
      statusRegion.textContent = msg('statusKeyCleared');
    })();
  });

  imageOnlyBox.addEventListener('change', () => {
    void (async () => {
      const settings = await loadSettings();
      await saveSettings({ ...settings, imageOnly: imageOnlyBox.checked });
    })();
  });

  req<HTMLInputElement>('prefer-on-device').addEventListener('change', (event) => {
    void (async () => {
      const settings = await loadSettings();
      await saveSettings({
        ...settings,
        preferOnDevice: (event.target as HTMLInputElement).checked,
      });
    })();
  });

  museRadio.addEventListener('change', () => {
    if (!museRadio.checked) {
      return;
    }
    void (async () => {
      const settings = await loadSettings();
      await saveSettings({ ...settings, activeProviderId: 'muse' });
      compatFields.hidden = true;
      showCompatError(null);
      statusRegion.textContent = msg('statusProviderSaved');
    })();
  });

  compatRadio.addEventListener('change', () => {
    if (!compatRadio.checked) {
      return;
    }
    // Reveals the server form; the switch itself lands on Save, after the
    // origin grant.
    compatFields.hidden = false;
  });

  req<HTMLButtonElement>('compat-save').addEventListener('click', () => {
    void (async () => {
      showCompatError(null);
      const baseURL = baseUrlInput.value.trim().replace(/\/+$/, '');
      let origin = '';
      try {
        const parsed = new URL(baseURL);
        const local =
          parsed.hostname === 'localhost' ||
          parsed.hostname === '127.0.0.1' ||
          parsed.hostname === '[::1]';
        if (
          (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) ||
          !parsed.hostname
        ) {
          throw new Error('unsupported server URL');
        }
        origin = parsed.origin;
      } catch {
        showCompatError('providerErrorUrl');
        return;
      }
      const model = modelInput.value.trim();
      if (!model) {
        showCompatError('providerErrorModel');
        return;
      }
      const parseRate = (raw: string): number | undefined => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return undefined;
        }
        const value = Number(trimmed);
        return Number.isFinite(value) && value >= 0 ? value : NaN;
      };
      const inputRatePerM = parseRate(inputRateInput.value);
      const outputRatePerM = parseRate(outputRateInput.value);
      if (Number.isNaN(inputRatePerM) || Number.isNaN(outputRatePerM)) {
        showCompatError('providerErrorRates');
        return;
      }
      // The user-specified server pattern: one persistent per-origin grant
      // for the configured baseURL (unlike the M2 byte-fetch, this grant is
      // needed for every call, so it is never removed here).
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      } catch {
        granted = false;
      }
      if (!granted) {
        showCompatError('providerErrorDenied');
        return;
      }
      const settings = await loadSettings();
      await saveSettings({
        ...settings,
        activeProviderId: 'openai_compat',
        openaiCompat: {
          baseURL,
          model,
          structuredOutput:
            structuredSelect.value === 'json_schema' ? 'json_schema' : 'json_object',
          ...(inputRatePerM === undefined ? {} : { inputRatePerM }),
          ...(outputRatePerM === undefined ? {} : { outputRatePerM }),
        },
      });
      statusRegion.textContent = msg('statusProviderSaved');
    })();
  });

  req<HTMLButtonElement>('reset-cost').addEventListener('click', () => {
    void (async () => {
      await resetMonthSpend();
      await refreshCost();
      statusRegion.textContent = msg('statusMonthlyReset');
    })();
  });
};

if (typeof document !== 'undefined') {
  initOptions();
}
