import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { KeySetup } from './components/key_setup/key_setup';
import { loadKey, saveKey } from './key_vault';
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
  shortcut: string;
  keyPending: boolean;
  keyError: string | null;
  sessionOnly: boolean;
  keyReset: number;
  customHost: string | null;
}

const store = createStore<OnboardingState>({
  status: '',
  shortcut: '',
  keyPending: false,
  keyError: null,
  sessionOnly: false,
  keyReset: 0,
  customHost: null,
});

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

const OnboardingApp = () => {
  const state = useSyncExternalStore(store.subscribe, store.get);
  return (
    <main>
      <h1 id="title">{msg('appName')}</h1>
      <p id="howto">{msg('onboardingHowto')}</p>
      <p id="shortcut-line">{state.shortcut}</p>
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
                await saveSettings({ ...settings, sessionOnly: checked });
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
      <div id="status-region" role="status" className="visually-hidden">
        {state.status}
      </div>
      <p id="try-hint">{msg('onboardingTryHint')}</p>
    </main>
  );
};

let initialized = false;

export const initOnboarding = (): void => {
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
        <OnboardingApp />
      </ErrorBoundary>
    );
  });

  void loadSettings().then((settings) => {
    store.set({ sessionOnly: settings.sessionOnly, customHost: customHostOf(settings) });
  });

  void chrome.commands
    .getAll()
    .then((commands) => {
      const action = commands.find((command) => command.name === '_execute_action');
      store.set({
        shortcut: action?.shortcut ? msg('shortcutLine', action.shortcut) : msg('shortcutUnset'),
      });
    })
    .catch(() => {
      store.set({ shortcut: msg('shortcutUnset') });
    });
};

if (typeof document !== 'undefined') {
  initOnboarding();
}
