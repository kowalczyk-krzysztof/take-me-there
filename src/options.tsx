import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { KeySetup } from './components/key_setup/key_setup';
import { clearAllKeys, clearKey, loadKey, saveKey, setKeyMode } from './key_vault';
import { formatUsd, readMonthSpend, resetMonthSpend } from './pricing';
import {
  ProviderError,
  customHostOf,
  getActiveProvider,
  loadSettings,
  parseEndpointOrigin,
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
    skipWebSearch: boolean;
    providerMuse: boolean;
    compat: CompatForm;
  } | null;
  compatOpen: boolean;
  compatError: string | null;
  compatConfirmHost: string | null;
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
  compatConfirmHost: null,
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
      const failureKey =
        err instanceof ProviderError && err.code === 'auth'
          ? 'keyErrorRejected'
          : err instanceof ProviderError && err.code === 'network'
            ? 'keyErrorNetwork'
            : 'keyErrorRetry';
      store.set({
        keyPending: false,
        keyError: msg(failureKey),
        status: msg(failureKey),
      });

      return;
    }

    const sessionOnly = store.get().sessionOnly;

    try {
      await saveKey(provider.id, key, sessionOnly);
      await saveSettings({ ...settings, sessionOnly });
    } catch {
      store.set({
        keyPending: false,
        keyError: msg('keyErrorRetry'),
        status: msg('keyErrorRetry'),
      });

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
      store.set({ keyError: msg('keyErrorEmpty'), status: msg('keyErrorEmpty') });

      return;
    }
    store.set({ status: msg('statusValidatingKey') });

    try {
      await provider.testKey(key);
    } catch (err) {
      const failureKey =
        err instanceof ProviderError && err.code === 'auth' ? 'keyErrorRejected' : 'keyErrorRetry';
      store.set({ keyError: msg(failureKey), status: msg(failureKey) });

      return;
    }

    store.set({ status: msg('statusKeyWorks') });
  })();
};

const showKeyCleared = (): void => {
  store.set({
    keyReset: store.get().keyReset + 1,
    keyError: null,
    keyPending: false,
    status: msg('statusKeyCleared'),
  });
};

const onClearKey = (): void => {
  void (async () => {
    const { provider } = await getActiveProvider();

    try {
      await clearKey(provider.id);
    } catch {
      store.set({ status: msg('settingsSaveFailed') });

      return;
    }

    showKeyCleared();
  })();
};

const onClearAllKeys = (): void => {
  void (async () => {
    try {
      await clearAllKeys();
    } catch {
      store.set({ status: msg('settingsSaveFailed') });

      return;
    }

    showKeyCleared();
  })();
};

// Previously configured custom origin, for obsolete-grant removal after a
// provider change. Empty unless custom is active with a parseable URL.
const customOriginOf = (settings: ExtensionSettings): string => {
  if (settings.activeProviderId !== 'openai_compat' || !settings.openaiCompat.baseURL) {
    return '';
  }

  try {
    return new URL(settings.openaiCompat.baseURL).origin;
  } catch {
    return '';
  }
};

const removeGrant = async (origin: string): Promise<void> => {
  try {
    await chrome.permissions.remove({ origins: [`${origin}/*`] });
  } catch {
    // The grant is already gone; nothing to clean up.
  }
};

const onCompatSave = (): void => {
  void (async () => {
    store.set({ compatError: null });

    const baseURL = inputValue('compat-base-url').trim().replace(/\/+$/, '');

    let origin = '';

    try {
      origin = parseEndpointOrigin(baseURL);
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

    const host = new URL(origin).host;

    const saved = await loadSettings();

    if (customHostOf(saved) !== host && store.get().compatConfirmHost !== host) {
      store.set({ compatError: msg('compatHostWarning', host), compatConfirmHost: host });

      return;
    }

    let preexisting = false;

    try {
      preexisting = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    } catch {
      preexisting = false;
    }

    let granted = preexisting;

    if (!preexisting) {
      try {
        granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      } catch {
        granted = false;
      }
    }
    if (!granted) {
      store.set({ compatError: msg('providerErrorDenied') });
      return;
    }
    const settings = await loadSettings();
    const previousOrigin = customOriginOf(settings);
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
      // The grant we just created is orphaned by the failed save: remove
      // it unless it predates us.
      if (!preexisting) {
        await removeGrant(origin);
      }
      store.set({ compatError: msg('settingsSaveFailed') });
      return;
    }
    // The replaced origin is obsolete to us: remove its grant. The new
    // origin keeps its (possibly pre-existing) grant.
    if (previousOrigin && previousOrigin !== origin) {
      await removeGrant(previousOrigin);
    }
    store.set({ compatError: null, compatConfirmHost: null, status: msg('statusProviderSaved') });
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
      } else if (box.id === 'skip-search') {
        const checked = box.checked;
        void (async () => {
          try {
            const current = await loadSettings();
            await saveSettings({ ...current, skipWebSearch: checked });
          } catch {
            box.checked = !checked;
            store.set({ status: msg('settingsSaveFailed') });
          }
        })();
      } else if (box.id === 'provider-muse' && box.checked) {
        void (async () => {
          let current;
          try {
            current = await loadSettings();
          } catch {
            box.checked = false;
            store.set({ status: msg('settingsSaveFailed') });
            return;
          }
          const previousOrigin = customOriginOf(current);
          try {
            await saveSettings({ ...current, activeProviderId: 'muse' });
          } catch {
            box.checked = false;
            store.set({ status: msg('settingsSaveFailed') });
            return;
          }
          if (previousOrigin) {
            await removeGrant(previousOrigin);
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
          customHost={
            state.settings === null
              ? null
              : customHostOf({
                  activeProviderId: state.settings.providerMuse ? 'muse' : 'openai_compat',
                  openaiCompat: { baseURL: state.settings.compat.baseURL },
                })
          }
          callbacks={{
            onSave: onSaveKey,
            onError: (text) => store.set({ keyError: text }),
            onSessionOnlyChange: (checked) => {
              store.set({ sessionOnly: checked });
              void (async () => {
                const { provider, settings } = await getActiveProvider();

                let result;

                try {
                  result = await setKeyMode(provider.id, checked);
                } catch {
                  store.set({
                    sessionOnly: settings.sessionOnly,
                    status: msg('settingsSaveFailed'),
                  });

                  return;
                }

                store.set({ sessionOnly: result.sessionOnly });

                if (result.error) {
                  store.set({ status: msg('settingsSaveFailed') });
                }
              })();
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
        <button id="clear-all-keys" type="button" onClick={onClearAllKeys}>
          {msg('clearAllKeysButton')}
        </button>
      </div>
      <div key={settings === null ? 'loading' : 'ready'}>
        <label className="checkbox-row" id="image-only-row">
          <input type="checkbox" id="image-only" defaultChecked={settings?.imageOnly ?? false} />
          <span id="image-only-label">{msg('imageOnlyLabel')}</span>
        </label>
        <label className="checkbox-row" id="skip-search-row">
          <input
            type="checkbox"
            id="skip-search"
            defaultChecked={settings?.skipWebSearch ?? false}
          />
          <span id="skip-search-label">{msg('skipSearchLabel')}</span>
        </label>
        <h2 id="provider-heading">{msg('optionsProviderHeading')}</h2>
        <div id="provider-group" role="radiogroup" aria-labelledby="provider-heading">
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
          <legend>{msg('compatLegend')}</legend>
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
              {msg(state.compatConfirmHost ? 'compatSaveAnyway' : 'compatSave')}
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
              try {
                await resetMonthSpend();
              } catch {
                store.set({ status: msg('settingsSaveFailed') });
                return;
              }
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
        skipWebSearch: settings.skipWebSearch,
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
