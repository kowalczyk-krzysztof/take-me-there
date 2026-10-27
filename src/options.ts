// Options page: key management around the shared key form, the image-only
// toggle, the monthly cost total with reset, and the privacy disclosure.
// Custom-provider settings arrive with the Milestone 2 release.
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
  req('cost-heading').textContent = msg('optionsCostHeading');
  req('privacy-heading').textContent = msg('optionsPrivacyHeading');
  req('privacy-body').textContent = msg('optionsPrivacyBody');
  const statusRegion = req('status-region');
  const costLine = req('cost-line');
  const imageOnlyBox = req<HTMLInputElement>('image-only');

  const keySetup = document.createElement('key-setup') as KeySetupElement;
  req('key-host').append(keySetup);

  const refreshCost = async (): Promise<void> => {
    const total = await readMonthSpend();
    costLine.textContent = msg('optionsCostMonth', formatUsd(total));
  };

  void loadSettings().then((settings) => {
    keySetup.setSessionOnly(settings.sessionOnly);
    imageOnlyBox.checked = settings.imageOnly;
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
