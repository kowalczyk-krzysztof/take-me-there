// Install-time welcome page: what the extension does, the shared key form,
// and a try-it hint. Skippable - the panel covers users who close it.
import './components/key_setup';
import type {
  KeySaveRequestDetail,
  KeySetupElement,
  SessionOnlyChangeDetail,
} from './components/key_setup';
import { ensureSharedStyles } from './components/shared_styles';
import { loadKey, saveKey } from './key_vault';
import {
  ProviderError,
  downloadNanoModel,
  getActiveProvider,
  loadSettings,
  nanoAvailability,
  saveSettings,
} from './providers/index';

const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);

const req = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`onboarding shell is missing #${id}`);
  }
  return el as T;
};

let initialized = false;

export const initOnboarding = (): void => {
  if (initialized) {
    return;
  }
  if (!document.getElementById('key-host')) {
    return;
  }
  initialized = true;
  ensureSharedStyles();

  document.title = msg('appName');
  document.documentElement.lang = msg('@@ui_locale').replace('_', '-');
  document.documentElement.dir = msg('@@bidi_dir');
  req('title').textContent = msg('appName');
  req('howto').textContent = msg('onboardingHowto');
  req('try-hint').textContent = msg('onboardingTryHint');
  const shortcutLine = req('shortcut-line');
  const statusRegion = req('status-region');

  const keySetup = document.createElement('key-setup') as KeySetupElement;
  req('key-host').append(keySetup);
  void loadSettings().then((settings) => {
    keySetup.setSessionOnly(settings.sessionOnly);
  });
  void chrome.commands
    .getAll()
    .then((commands) => {
      const action = commands.find((command) => command.name === '_execute_action');
      shortcutLine.textContent = action?.shortcut
        ? msg('shortcutLine', action.shortcut)
        : msg('shortcutUnset');
    })
    .catch(() => {
      shortcutLine.textContent = msg('shortcutUnset');
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

  keySetup.addEventListener('nano-enable', () => {
    void (async () => {
      const state = await nanoAvailability();
      if (state === 'unavailable') {
        keySetup.setNano('hidden');
        statusRegion.textContent = msg('nanoUnavailable');
        return;
      }
      if (state !== 'readily') {
        keySetup.setNano('downloading');
        statusRegion.textContent = msg('nanoDownloadStart');
        try {
          await downloadNanoModel((frac) => keySetup.setNanoProgress(frac));
        } catch {
          keySetup.setNano('failed');
          statusRegion.textContent = msg('nanoDownloadFail');
          return;
        }
        statusRegion.textContent = msg('nanoDownloadReady');
      }
      const settings = await loadSettings();
      await saveSettings({ ...settings, preferOnDevice: true });
      keySetup.setNano('hidden');
      statusRegion.textContent = msg('nanoReady');
    })();
  });
  void (async () => {
    const state = await nanoAvailability();
    if (state === 'readily' || state === 'downloadable' || state === 'downloading') {
      keySetup.setNano(state === 'readily' ? 'ready' : 'downloadable');
    }
  })();
};

if (typeof document !== 'undefined') {
  initOnboarding();
}
