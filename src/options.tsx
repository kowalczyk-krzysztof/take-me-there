import { useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { KeySetup } from './components/key_setup/key_setup';
import { ModesSection } from './components/settings/modes_section';
import { DataSection } from './components/settings/data_section';
import { CostSection } from './components/settings/cost_section';
import { clearResultCache, setCacheTtlDays, setMode } from './settings_ops';
import { refreshSettings, subscribeSettings } from './settings_store';
import { clearKey, loadKey } from './key_vault';
import { applyKeyMode, validateAndSaveKey } from './key_ops';
import { formatUsd, readMonthSpend } from './pricing';
import { ProviderError, getProvider } from './providers/index';
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
    cacheTtlDays: number;
  } | null;
  settingsFailed: boolean;
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
  settingsFailed: false,
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

    const outcome = await validateAndSaveKey(key, store.get().sessionOnly);

    if (!outcome.ok) {
      store.set({
        keyPending: false,
        keyError: msg(outcome.failure),
        status: msg(outcome.failure),
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
    const provider = getProvider();

    const draft = inputValue('key-input').trim();

    let key = draft;

    if (!key) {
      let loaded;

      try {
        loaded = await loadKey(provider.id);
      } catch {
        store.set({ status: msg('settingsSaveFailed') });

        return;
      }
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
    const provider = getProvider();

    try {
      await clearKey(provider.id);
    } catch {
      store.set({ status: msg('settingsSaveFailed') });

      return;
    }

    showKeyCleared();
  })();
};

const onMode = (mode: 'imageOnly' | 'skipWebSearch', checked: boolean): void => {
  void (async () => {
    try {
      await setMode(mode, checked);
    } catch {
      await refreshSettings();
      store.set({ status: msg('settingsSaveFailed') });
    }
  })();
};

const onRetention = (days: number): void => {
  if (days !== 1 && days !== 7 && days !== 30) {
    return;
  }

  void (async () => {
    try {
      await setCacheTtlDays(days as 1 | 7 | 30);
    } catch {
      await refreshSettings();
      store.set({ status: msg('settingsSaveFailed') });
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

const OptionsApp = () => {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const settings = state.settings;
  return (
    <main>
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
                const outcome = await applyKeyMode(checked);

                store.set({ sessionOnly: outcome.sessionOnly });

                if (outcome.failed) {
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
      </div>
      <div>
        <ModesSection
          heading={msg('optionsModesHeading')}
          imageOnly={settings?.imageOnly ?? false}
          skipWebSearch={settings?.skipWebSearch ?? false}
          failed={state.settingsFailed}
          onMode={onMode}
          onRetry={() => void refreshSettings()}
        />
        <DataSection
          heading={msg('optionsDataHeading')}
          ttlDays={settings?.cacheTtlDays ?? 7}
          disabled={state.settingsFailed}
          cachePending={state.cachePending}
          cacheResult={state.cacheResult}
          onRetention={onRetention}
          onClearCache={onClearCache}
        />
      </div>
      <CostSection
        heading={msg('costHeading')}
        headingId="cost-heading"
        lineId="cost-line"
        costText={state.costText}
      />
      <h2 id="privacy-heading">{msg('optionsPrivacyHeading')}</h2>
      <p id="privacy-body">{msg('optionsPrivacyBody')}</p>
      <div
        id="status-region"
        role="status"
        className="key-result"
        hidden={state.status === '' || undefined}
      >
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
  subscribeSettings((snapshot) => {
    const current = snapshot.settings;

    store.set({
      sessionOnly: current.sessionOnly,
      settingsFailed: snapshot.failed,
      settings: {
        imageOnly: current.imageOnly,
        skipWebSearch: current.skipWebSearch,
        cacheTtlDays: current.cacheTtlDays,
      },
    });
  });
  void refreshCost();
};

if (typeof document !== 'undefined') {
  initOptions();
}
