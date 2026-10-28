import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { KeySetup } from './components/key_setup/key_setup';
import { clearKey, loadKey, saveKey } from './key_vault';
import { formatUsd, readMonthSpend, resetMonthSpend } from './pricing';
import {
  ProviderError,
  getActiveProvider,
  loadSettings,
  saveSettings,
  type ExtensionSettings,
} from './providers/index';
import { ErrorBoundary } from './components/error_boundary/error_boundary';
import { msg } from './utils/i18n';
import { createStore } from './utils/store';
import './styles/options.css';
import './components/shared_styles.css';

interface CompatForm {
  baseURL: string;
  model: string;
  structured: string;
  inputRate: string;
  outputRate: string;
}

interface OptionsState {
  status: string;
  costText: string;
  keyPending: boolean;
  keyError: string | null;
  sessionOnly: boolean;
  keyReset: number;
  settings: {
    imageOnly: boolean;
    providerMuse: boolean;
    compat: CompatForm;
  } | null;
  compatOpen: boolean;
  compatError: string | null;
}

const store = createStore<OptionsState>({
  status: '',
  costText: '',
  keyPending: false,
  keyError: null,
  sessionOnly: false,
  keyReset: 0,
  settings: null,
  compatOpen: false,
  compatError: null,
});

const inputValue = (id: string): string =>
  (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';

const refreshCost = async (): Promise<void> => {
  try {
    store.set({ costText: msg('optionsCostMonth', formatUsd(await readMonthSpend())) });
  } catch {
    store.set({ costText: msg('optionsCostMonth', formatUsd(0)) });
  }
};

const onSaveKey = (key: string): void => {
  void (async () => {
    store.set({ keyPending: true, keyError: null, status: msg('statusValidatingKey') });
    const { provider, settings } = await getActiveProvider();

    try {
      await provider.testKey(key);
    } catch (err) {
      store.set({
        keyPending: false,
        keyError:
          err instanceof ProviderError && err.code === 'auth'
            ? msg('keyErrorRejected')
            : err instanceof ProviderError && err.code === 'network'
              ? msg('keyErrorNetwork')
              : msg('keyErrorRetry'),
      });
      return;
    }

    const sessionOnly = store.get().sessionOnly;

    try {
      await saveKey(provider.id, key, sessionOnly);
      await saveSettings({ ...settings, sessionOnly });
    } catch {
      store.set({ keyPending: false, keyError: msg('keyErrorRetry') });
      return;
    }

    store.set({
      keyPending: false,
      keyError: null,
      keyReset: store.get().keyReset + 1,
      status: msg('statusKeySaved'),
    });
  })();
};

const onTestKey = (): void => {
  void (async () => {
    const { provider } = await getActiveProvider();
    const draft = inputValue('key-input').trim();
    let key = draft;

    if (!key) {
      const loaded = await loadKey(provider.id);
      key = loaded.state === 'ok' ? loaded.key : '';
    }

    if (!key) {
      store.set({ keyError: msg('keyErrorEmpty') });
      return;
    }
    store.set({ status: msg('statusValidatingKey') });

    try {
      await provider.testKey(key);
    } catch (err) {
      store.set({
        keyError:
          err instanceof ProviderError && err.code === 'auth'
            ? msg('keyErrorRejected')
            : msg('keyErrorRetry'),
      });
      return;
    }

    store.set({ status: msg('statusKeyWorks') });
  })();
};

const onClearKey = (): void => {
  void (async () => {
    const { provider } = await getActiveProvider();

    await clearKey(provider.id);

    store.set({
      keyReset: store.get().keyReset + 1,
      keyError: null,
      keyPending: false,
      status: msg('statusKeyCleared'),
    });
  })();
};

const onCompatSave = (): void => {
  void (async () => {
    store.set({ compatError: null });
    const baseURL = inputValue('compat-base-url').trim().replace(/\/+$/, '');
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
      store.set({ compatError: msg('providerErrorUrl') });
      return;
    }
    const model = inputValue('compat-model').trim();
    if (!model) {
      store.set({ compatError: msg('providerErrorModel') });
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
    const inputRatePerM = parseRate(inputValue('compat-input-rate'));
    const outputRatePerM = parseRate(inputValue('compat-output-rate'));
    if (Number.isNaN(inputRatePerM) || Number.isNaN(outputRatePerM)) {
      store.set({ compatError: msg('providerErrorRates') });
      return;
    }
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    } catch {
      granted = false;
    }
    if (!granted) {
      store.set({ compatError: msg('providerErrorDenied') });
      return;
    }
    const settings = await loadSettings();
    const structuredSelect = document.getElementById(
      'compat-structured'
    ) as HTMLSelectElement | null;
    const next: ExtensionSettings = {
      ...settings,
      activeProviderId: 'openai_compat',
      openaiCompat: {
        baseURL,
        model,
        structuredOutput: structuredSelect?.value === 'json_schema' ? 'json_schema' : 'json_object',
        ...(inputRatePerM === undefined ? {} : { inputRatePerM }),
        ...(outputRatePerM === undefined ? {} : { outputRatePerM }),
      },
    };
    try {
      await saveSettings(next);
    } catch {
      store.set({ compatError: msg('settingsSaveFailed') });
      return;
    }
    store.set({ status: msg('statusProviderSaved') });
  })();
};

const OptionsApp = () => {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const settings = state.settings;
  // Native listener: React's change tracking drops programmatic checked
  // sets, which callers use.
  const attach = (el: HTMLElement | null): (() => void) | void => {
    if (!el) {
      return;
    }
    const onChange = (event: Event): void => {
      const box = event.target;
      if (!(box instanceof HTMLInputElement)) {
        return;
      }
      if (box.id === 'image-only') {
        const checked = box.checked;
        void (async () => {
          try {
            const current = await loadSettings();
            await saveSettings({ ...current, imageOnly: checked });
          } catch {
            box.checked = !checked;
            store.set({ status: msg('settingsSaveFailed') });
          }
        })();
      } else if (box.id === 'provider-muse' && box.checked) {
        void (async () => {
          try {
            const current = await loadSettings();
            await saveSettings({ ...current, activeProviderId: 'muse' });
          } catch {
            box.checked = false;
            store.set({ status: msg('settingsSaveFailed') });
            return;
          }
          store.set({ compatOpen: false, compatError: null, status: msg('statusProviderSaved') });
        })();
      } else if (box.id === 'provider-compat' && box.checked) {
        store.set({ compatOpen: true });
      }
    };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  };
  return (
    <main ref={attach}>
      <h1 id="title">{msg('appName')}</h1>
      <h2 id="key-heading">{msg('optionsKeyHeading')}</h2>
      <div id="key-host">
        <KeySetup
          mode="setup"
          pending={state.keyPending}
          error={state.keyError}
          sessionOnly={state.sessionOnly}
          resetKey={state.keyReset}
          callbacks={{
            onSave: onSaveKey,
            onError: (text) => store.set({ keyError: text }),
            onSessionOnlyChange: (checked) => {
              store.set({ sessionOnly: checked });
              void (async () => {
                const { provider, settings: current } = await getActiveProvider();
                await saveSettings({ ...current, sessionOnly: checked });
                const loaded = await loadKey(provider.id);
                if (loaded.state === 'ok') {
                  await saveKey(provider.id, loaded.key, checked);
                }
              })().catch(() => {
                // Best effort; the checkbox state stays as the user set it.
              });
            },
            onConsentDecision: () => {},
          }}
        />
      </div>
      <div className="button-row">
        <button id="test-key" type="button" onClick={onTestKey}>
          {msg('testKeyButton')}
        </button>
        <button id="clear-key" type="button" onClick={onClearKey}>
          {msg('clearKeyButton')}
        </button>
      </div>
      <div key={settings === null ? 'loading' : 'ready'}>
        <label className="checkbox-row" id="image-only-row">
          <input type="checkbox" id="image-only" defaultChecked={settings?.imageOnly ?? false} />
          <span id="image-only-label">{msg('imageOnlyLabel')}</span>
        </label>
        <h2 id="provider-heading">{msg('optionsProviderHeading')}</h2>
        <div id="provider-group" role="radiogroup">
          <label className="radio-row">
            <input
              type="radio"
              name="provider"
              value="muse"
              id="provider-muse"
              defaultChecked={settings !== null && settings.providerMuse}
            />
            <span id="provider-muse-label">{msg('providerMuse')}</span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="provider"
              value="openai_compat"
              id="provider-compat"
              defaultChecked={settings !== null && !settings.providerMuse}
            />
            <span id="provider-compat-label">{msg('providerCompat')}</span>
          </label>
        </div>
        <fieldset id="compat-fields" hidden={!state.compatOpen || undefined}>
          <label className="field-row">
            <span id="compat-base-url-label">{msg('compatBaseUrl')}</span>
            <input
              type="url"
              id="compat-base-url"
              autoComplete="url"
              defaultValue={settings?.compat.baseURL ?? ''}
            />
          </label>
          <label className="field-row">
            <span id="compat-model-label">{msg('compatModel')}</span>
            <input
              type="text"
              id="compat-model"
              autoComplete="off"
              defaultValue={settings?.compat.model ?? ''}
            />
          </label>
          <label className="field-row">
            <span id="compat-structured-label">{msg('compatStructured')}</span>
            <select
              id="compat-structured"
              defaultValue={settings?.compat.structured ?? 'json_schema'}
            >
              <option value="json_schema" id="compat-structured-schema">
                {msg('compatStructuredSchema')}
              </option>
              <option value="json_object" id="compat-structured-object">
                {msg('compatStructuredObject')}
              </option>
            </select>
          </label>
          <label className="field-row">
            <span id="compat-input-rate-label">{msg('compatInputRate')}</span>
            <input
              type="number"
              id="compat-input-rate"
              min="0"
              step="any"
              defaultValue={settings?.compat.inputRate ?? ''}
            />
          </label>
          <label className="field-row">
            <span id="compat-output-rate-label">{msg('compatOutputRate')}</span>
            <input
              type="number"
              id="compat-output-rate"
              min="0"
              step="any"
              defaultValue={settings?.compat.outputRate ?? ''}
            />
          </label>
          <div className="button-row">
            <button id="compat-save" type="button" onClick={onCompatSave}>
              {msg('compatSave')}
            </button>
          </div>
          <p id="compat-error" role="alert" hidden={state.compatError === null || undefined}>
            {state.compatError}
          </p>
        </fieldset>
      </div>
      <h2 id="cost-heading">{msg('optionsCostHeading')}</h2>
      <p id="cost-line">{state.costText}</p>
      <div className="button-row">
        <button
          id="reset-cost"
          type="button"
          onClick={() => {
            void (async () => {
              await resetMonthSpend();
              await refreshCost();
              store.set({ status: msg('statusMonthlyReset') });
            })();
          }}
        >
          {msg('resetCostButton')}
        </button>
      </div>
      <h2 id="privacy-heading">{msg('optionsPrivacyHeading')}</h2>
      <p id="privacy-body">{msg('optionsPrivacyBody')}</p>
      <div id="status-region" role="status" className="visually-hidden">
        {state.status}
      </div>
    </main>
  );
};

let initialized = false;

export const initOptions = (): void => {
  if (initialized) {
    return;
  }
  const host = document.getElementById('root');
  if (!host) {
    return;
  }
  initialized = true;

  document.title = msg('appName');
  document.documentElement.lang = msg('@@ui_locale').replace('_', '-');
  document.documentElement.dir = msg('@@bidi_dir');
  flushSync(() => {
    createRoot(host).render(
      <ErrorBoundary
        fallback={() => (
          <main>
            <h2 tabIndex={-1}>{msg('errorServerTitle')}</h2>
            <p>{msg('errorServerBody')}</p>
            <button type="button" onClick={() => window.location.reload()}>
              {msg('retryButton')}
            </button>
          </main>
        )}
      >
        <OptionsApp />
      </ErrorBoundary>
    );
  });
  void loadSettings().then((settings) => {
    store.set({
      sessionOnly: settings.sessionOnly,
      compatOpen: settings.activeProviderId === 'openai_compat',
      settings: {
        imageOnly: settings.imageOnly,
        providerMuse: settings.activeProviderId !== 'openai_compat',
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
        },
      },
    });
  });
  void refreshCost();
};

if (typeof document !== 'undefined') {
  initOptions();
}
