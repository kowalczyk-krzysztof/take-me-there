import { useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { KeySetup } from './components/key_setup/key_setup';
import { clearKey } from './key_vault';
import { applyKeyMode, validateAndSaveKey } from './key_ops';
import { subscribeSettings } from './settings_store';
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
  keySaved: boolean;
}

const store = createStore<OnboardingState>({
  status: '',
  keyPending: false,
  keyError: null,
  sessionOnly: false,
  keyReset: 0,
  keySaved: false,
});

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
      keySaved: true,
      status: msg('statusKeySaved'),
    });
  })();
};

const onClearKey = (): void => {
  void (async () => {
    try {
      await clearKey('muse');
    } catch {
      store.set({ keyError: msg('settingsSaveFailed') });

      return;
    }

    store.set({
      keyError: null,
      keyReset: store.get().keyReset + 1,
      keySaved: false,
    });
  })();
};

const OnboardingApp = () => {
  const state = useSyncExternalStore(store.subscribe, store.get);

  return (
    <main>
      <div className="panel-card title-card">
        <div className="title-row">
          <img src="icons/48.png" alt="" width={40} height={40} />
          <h1 id="title">{msg('appName')}</h1>
        </div>
        <p id="howto">{msg('onboardingHowto')}</p>
      </div>
      <div id="key-host">
        {!state.keySaved ? (
          <KeySetup
            mode="setup"
            pending={state.keyPending}
            error={state.keyError}
            sessionOnly={state.sessionOnly}
            resetKey={state.keyReset}
            laterNote={msg('onboardingKeyLater')}
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
        ) : (
          <section className="panel-card" aria-labelledby="key-saved-heading">
            <h2 id="key-saved-heading">{msg('settingsKeyHeading')}</h2>
            <p id="key-saved-status">{msg('keySavedStatus')}</p>
            {state.keyError === null ? null : <p id="key-saved-error">{state.keyError}</p>}
            <div className="confirm-actions">
              <button
                type="button"
                onClick={() =>
                  store.set({
                    keyError: null,
                    keyReset: state.keyReset + 1,
                    keySaved: false,
                  })
                }
              >
                {msg('keyReplaceButton')}
              </button>
              <button type="button" onClick={onClearKey}>
                {msg('clearKeyButton')}
              </button>
            </div>
          </section>
        )}
      </div>
      <div id="status-region" role="status" className="visually-hidden">
        {state.status}
      </div>
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

  subscribeSettings((snapshot) => {
    store.set({ sessionOnly: snapshot.settings.sessionOnly });
  });
};

if (typeof document !== 'undefined') {
  initOnboarding();
}
