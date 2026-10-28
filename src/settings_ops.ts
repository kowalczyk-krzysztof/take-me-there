import { removeGrant } from './grants';
import {
  parseEndpointOrigin,
  loadSettings,
  saveSettings,
  type CacheTtlDays,
  type ExtensionSettings,
} from './settings_store';
import { sendCommand } from './storage_client';
import { customHostOf } from './providers/index';

export interface CompatFormValues {
  baseURL: string;
  model: string;
  structured: string;
  inputRate: string;
  outputRate: string;
  cachedRate: string;
}

export const EMPTY_COMPAT_FORM: CompatFormValues = {
  baseURL: '',
  model: '',
  structured: '',
  inputRate: '',
  outputRate: '',
  cachedRate: '',
};

export const compatErrorKey = (error: 'url' | 'model' | 'rates' | 'denied' | 'save'): string => {
  if (error === 'url') {
    return 'providerErrorUrl';
  }

  if (error === 'model') {
    return 'providerErrorModel';
  }

  if (error === 'rates') {
    return 'providerErrorRates';
  }

  if (error === 'denied') {
    return 'providerErrorDenied';
  }

  return 'settingsSaveFailed';
};

export type CompatSaveOutcome =
  | { status: 'saved' }
  | { status: 'confirm'; host: string }
  | { status: 'error'; error: 'url' | 'model' | 'rates' | 'denied' | 'save' };

export const customOriginOf = (settings: ExtensionSettings): string => {
  if (settings.activeProviderId !== 'openai_compat' || !settings.openaiCompat.baseURL) {
    return '';
  }

  try {
    return new URL(settings.openaiCompat.baseURL).origin;
  } catch {
    return '';
  }
};

export const setMode = async (
  mode: 'imageOnly' | 'skipWebSearch',
  checked: boolean
): Promise<void> => {
  const current = await loadSettings();

  await saveSettings({ ...current, [mode]: checked });
};

export const setCacheTtlDays = async (days: CacheTtlDays): Promise<void> => {
  const current = await loadSettings();

  await saveSettings({ ...current, cacheTtlDays: days });
};

export const switchToClaude = async (): Promise<void> => {
  const current = await loadSettings();

  const previousOrigin = customOriginOf(current);

  await saveSettings({ ...current, activeProviderId: 'muse' });

  if (previousOrigin) {
    await removeGrant(previousOrigin);
  }
};

const parseRate = (raw: string): number | undefined => {
  const trimmed = raw.trim();

  if (!trimmed) {
    return undefined;
  }

  const value = Number(trimmed);

  return Number.isFinite(value) && value >= 0 ? value : NaN;
};

export const saveCompatProvider = async (
  values: CompatFormValues,
  confirmHost: string | null
): Promise<CompatSaveOutcome> => {
  const baseURL = values.baseURL.trim().replace(/\/+$/, '');

  let origin = '';

  try {
    origin = parseEndpointOrigin(baseURL);
  } catch {
    return { status: 'error', error: 'url' };
  }

  const model = values.model.trim();

  if (!model) {
    return { status: 'error', error: 'model' };
  }

  const inputRatePerM = parseRate(values.inputRate);

  const outputRatePerM = parseRate(values.outputRate);

  const cachedRatePerM = parseRate(values.cachedRate);

  if (Number.isNaN(inputRatePerM) || Number.isNaN(outputRatePerM) || Number.isNaN(cachedRatePerM)) {
    return { status: 'error', error: 'rates' };
  }

  const host = new URL(origin).host;

  const saved = await loadSettings();

  if (customHostOf(saved) !== host && confirmHost !== host) {
    return { status: 'confirm', host };
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
    return { status: 'error', error: 'denied' };
  }

  const settings = await loadSettings();

  const previousOrigin = customOriginOf(settings);

  const next: ExtensionSettings = {
    ...settings,
    activeProviderId: 'openai_compat',
    openaiCompat: {
      baseURL,
      model,
      structuredOutput: values.structured === 'json_schema' ? 'json_schema' : 'json_object',
      ...(inputRatePerM === undefined ? {} : { inputRatePerM }),
      ...(outputRatePerM === undefined ? {} : { outputRatePerM }),
      ...(cachedRatePerM === undefined ? {} : { cachedRatePerM }),
    },
  };

  try {
    await saveSettings(next);
  } catch {
    if (!preexisting) {
      await removeGrant(origin);
    }

    return { status: 'error', error: 'save' };
  }

  if (previousOrigin && previousOrigin !== origin) {
    await removeGrant(previousOrigin);
  }

  return { status: 'saved' };
};

export const clearResultCache = async (): Promise<number> =>
  sendCommand<number>({ kind: 'cache.clear' });

export interface SettingsInputHandlers {
  onMode?: (mode: 'imageOnly' | 'skipWebSearch', box: HTMLInputElement) => void;
  onMuse: (box: HTMLInputElement) => void;
  onCompat: () => void;
  onRetention?: (days: number, select: HTMLSelectElement) => void;
}

export const attachSettingsInputs = (
  el: HTMLElement,
  handlers: SettingsInputHandlers
): (() => void) => {
  const onChange = (event: Event): void => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.id === 'image-only' || target.id === 'skip-search') {
      handlers.onMode?.(
        target.id === 'image-only' ? 'imageOnly' : 'skipWebSearch',
        target as HTMLInputElement
      );
    } else if (target.id === 'provider-muse' && (target as HTMLInputElement).checked) {
      handlers.onMuse(target as HTMLInputElement);
    } else if (target.id === 'provider-compat' && (target as HTMLInputElement).checked) {
      handlers.onCompat();
    } else if (target.id === 'retention-select') {
      const select = target as HTMLSelectElement;

      handlers.onRetention?.(Number(select.value), select);
    }
  };

  el.addEventListener('change', onChange);

  return () => el.removeEventListener('change', onChange);
};
