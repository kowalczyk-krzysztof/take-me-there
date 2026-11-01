import type { CacheTtlDays } from './settings_store';
import { sendCommand } from './storage_client';

export const setMode = async (
  mode: 'imageOnly' | 'skipWebSearch',
  checked: boolean
): Promise<void> => {
  await sendCommand<void>({ kind: 'settings.patch', patch: { [mode]: checked } });
};

export const setCacheTtlDays = async (days: CacheTtlDays): Promise<void> => {
  await sendCommand<void>({ kind: 'settings.patch', patch: { cacheTtlDays: days } });
};

export const clearResultCache = async (): Promise<number> =>
  sendCommand<number>({ kind: 'cache.clear' });
