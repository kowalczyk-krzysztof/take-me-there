import { loadSettings, saveSettings, type CacheTtlDays } from './settings_store';
import { sendCommand } from './storage_client';

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

export const clearResultCache = async (): Promise<number> =>
  sendCommand<number>({ kind: 'cache.clear' });

export interface SettingsInputHandlers {
  onMode?: (mode: 'imageOnly' | 'skipWebSearch', box: HTMLInputElement) => void;
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
    } else if (target.id === 'retention-select') {
      const select = target as HTMLSelectElement;

      handlers.onRetention?.(Number(select.value), select);
    }
  };

  el.addEventListener('change', onChange);

  return () => el.removeEventListener('change', onChange);
};
