import { useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { KeySetup } from './components/key_setup/key_setup';
import { ProviderSection } from './components/settings/provider_section';
import { ModesSection } from './components/settings/modes_section';
import { DataSection } from './components/settings/data_section';
import { CostSection } from './components/settings/cost_section';
import {
  attachSettingsInputs,
  compatErrorKey,
  clearResultCache,
  saveCompatProvider,
  setCacheTtlDays,
  setMode,
  switchToClaude,
  type CompatFormValues,
} from './settings_ops';
import { clearAllKeys, clearKey, loadKey, saveKey, setKeyMode } from './key_vault';
import { formatUsd, readMonthSpend, resetMonthSpend } from './pricing';
import {
  ProviderError,
  customHostOf,
  getActiveProvider,
  loadSettings,
  saveSettings,
} from './providers/index';
import { ErrorBoundary } from './components/error_boundary/error_boundary';
import { msg } from './utils/i18n';
import { createStore } from './utils/store';
import './styles/options.css';
import './components/shared_styles.css';

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
    compat: CompatFormValues;
    cacheTtlDays: number;
  } | null;
  compatOpen: boolean;
  compatError: string | null;
  compatConfirmHost: string | null;
  cachePending: boolean;
  cacheResult: string | null;
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
  cachePending: false,
  cacheResult: null,
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

const onCompatSave = (): void => {
  void (async () => {
    store.set({ compatError: null });

    const outcome = await saveCompatProvider(
      {
        baseURL: inputValue('compat-base-url'),
        model: inputValue('compat-model'),
      },
      store.get().compatConfirmHost
    );

    if (outcome.status === 'saved') {
      store.set({
        compatError: null,
        compatConfirmHost: null,
        status: msg('statusProviderSaved'),
      });

      return;
    }

    if (outcome.status === 'confirm') {
      store.set({
        compatError: msg('compatHostWarning', outcome.host),
        compatConfirmHost: outcome.host,
      });

      return;
    }

    store.set({ compatError: msg(compatErrorKey(outcome.error)) });
  })();
};

const onRetention = (days: number, select: HTMLSelectElement): void => {
  const settings = store.get().settings;

  const current = settings?.cacheTtlDays ?? 7;

  if (days !== 1 && days !== 7 && days !== 30) {
    select.value = String(current);

    return;
  }

  void (async () => {
    try {
      await setCacheTtlDays(days as 1 | 7 | 30);
    } catch {
      select.value = String(current);
      store.set({ status: msg('settingsSaveFailed') });

      return;
    }

    if (settings) {
      store.set({ settings: { ...settings, cacheTtlDays: days } });
    }
  })();
};

const onClearCache = (): void => {
  void (async () => {
    store.set({ cachePending: true, cacheResult: null });

    let cleared = 0;

    try {
      cleared = await clearResultCache();
    } catch {
      store.set({ cachePending: false, cacheResult: msg('cacheClearFailed') });

      return;
    }

    const result =
      cleared === 0
        ? msg('cacheClearedNone')
        : cleared === 1
          ? msg('cacheClearedOne')
          : msg('cacheClearedMany', String(cleared));

    store.set({ cachePending: false, cacheResult: result });
  })();
};

const onResetCost = (): void => {
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

    return attachSettingsInputs(el, {
      onMode: (mode, box) => {
        const checked = box.checked;

        void (async () => {
          try {
            await setMode(mode, checked);
          } catch {
            box.checked = !checked;
            store.set({ status: msg('settingsSaveFailed') });
          }
        })();
      },
      onMuse: (box) => {
        void (async () => {
          try {
            await switchToClaude();
          } catch {
            box.checked = false;
            store.set({ status: msg('settingsSaveFailed') });

            return;
          }

          store.set({
            compatOpen: false,
            compatError: null,
            compatConfirmHost: null,
            status: msg('statusProviderSaved'),
          });
        })();
      },
      onCompat: () => {
        store.set({ compatOpen: true });
      },
      onRetention,
    });
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
        <ModesSection
          heading={msg('optionsModesHeading')}
          imageOnly={settings?.imageOnly ?? false}
          skipWebSearch={settings?.skipWebSearch ?? false}
        />
        <ProviderSection
          heading={msg('optionsProviderHeading')}
          ready={settings !== null}
          providerMuse={settings?.providerMuse ?? false}
          compatOpen={state.compatOpen}
          compat={settings?.compat ?? null}
          compatError={state.compatError}
          confirmHost={state.compatConfirmHost}
          onSave={onCompatSave}
        />
        <DataSection
          heading={msg('optionsDataHeading')}
          ttlDays={settings?.cacheTtlDays ?? 7}
          cachePending={state.cachePending}
          cacheResult={state.cacheResult}
          onClearCache={onClearCache}
        />
      </div>
      <CostSection
        heading={msg('optionsCostHeading')}
        headingId="cost-heading"
        lineId="cost-line"
        buttonId="reset-cost"
        costText={state.costText}
        runText=""
        runLineId="options-run-line"
        onReset={onResetCost}
      />
      <h2 id="privacy-heading">{msg('optionsPrivacyHeading')}</h2>
      <p id="privacy-body">{msg('optionsPrivacyBody')}</p>
      <div id="status-region" role="status" className="visually-hidden">
        {state.status}
      </div>
    </main>
  );
};

let initialized = false;

let optionsRoot: Root | null = null;

export const unmountPage = (): void => {
  optionsRoot?.unmount();
  optionsRoot = null;
};

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
  optionsRoot = createRoot(host);
  const root = optionsRoot;
  flushSync(() => {
    root.render(
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
        },
        cacheTtlDays: settings.cacheTtlDays,
      },
    });
  });
  void refreshCost();
};

if (typeof document !== 'undefined') {
  initOptions();
}
