import { useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { KeySetup } from './components/key_setup/key_setup';
import { ProviderSection } from './components/settings/provider_section';
import {
  attachSettingsInputs,
  compatErrorKey,
  saveCompatProvider,
  switchToClaude,
  type CompatFormValues,
} from './settings_ops';
import { saveKey, setKeyMode } from './key_vault';
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

interface OnboardingState {
  status: string;
  keyPending: boolean;
  keyError: string | null;
  sessionOnly: boolean;
  keyReset: number;
  customHost: string | null;
  settings: {
    providerMuse: boolean;
    compat: CompatFormValues;
  } | null;
  compatOpen: boolean;
  compatError: string | null;
  compatConfirmHost: string | null;
}

const store = createStore<OnboardingState>({
  status: '',
  keyPending: false,
  keyError: null,
  sessionOnly: false,
  keyReset: 0,
  customHost: null,
  settings: null,
  compatOpen: false,
  compatError: null,
  compatConfirmHost: null,
});

const inputValue = (id: string): string =>
  (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';

const refreshCustomHost = async (): Promise<void> => {
  try {
    store.set({ customHost: customHostOf(await loadSettings()) });
  } catch {
    // Keep the previous host on storage failure.
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
      await refreshCustomHost();

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

const OnboardingApp = () => {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const settings = state.settings;

  const attach = (el: HTMLElement | null): (() => void) | void => {
    if (!el) {
      return;
    }

    return attachSettingsInputs(el, {
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
          await refreshCustomHost();
        })();
      },
      onCompat: () => {
        store.set({ compatOpen: true });
      },
    });
  };

  return (
    <main ref={attach}>
      <h1 id="title">{msg('appName')}</h1>
      <p id="howto">{msg('onboardingHowto')}</p>
      <div key={settings === null ? 'loading' : 'ready'}>
        <ProviderSection
          heading={msg('onboardingProviderHeading')}
          ready={settings !== null}
          providerMuse={settings?.providerMuse ?? false}
          compatOpen={state.compatOpen}
          compat={settings?.compat ?? null}
          compatError={state.compatError}
          confirmHost={state.compatConfirmHost}
          onSave={onCompatSave}
        />
      </div>
      <div id="key-host">
        <KeySetup
          mode="setup"
          pending={state.keyPending}
          error={state.keyError}
          sessionOnly={state.sessionOnly}
          resetKey={state.keyReset}
          customHost={state.customHost}
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
      <div id="status-region" role="status" className="visually-hidden">
        {state.status}
      </div>
      <p id="try-hint">{msg('onboardingTryHint')}</p>
    </main>
  );
};

let initialized = false;

let onboardingRoot: Root | null = null;

export const unmountPage = (): void => {
  onboardingRoot?.unmount();
  onboardingRoot = null;
};

export const initOnboarding = (): void => {
  if (initialized) {
    return;
  }

  const host = document.getElementById('root');

  if (!host) {
    return;
  }

  initialized = true;

  onboardingRoot = createRoot(host);
  const root = onboardingRoot;
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
        <OnboardingApp />
      </ErrorBoundary>
    );
  });

  void loadSettings().then((settings) => {
    store.set({
      sessionOnly: settings.sessionOnly,
      customHost: customHostOf(settings),
      compatOpen: settings.activeProviderId === 'openai_compat',
      settings: {
        providerMuse: settings.activeProviderId !== 'openai_compat',
        compat: {
          baseURL: settings.openaiCompat.baseURL,
          model: settings.openaiCompat.model,
        },
      },
    });
  });
};

if (typeof document !== 'undefined') {
  initOnboarding();
}
