import type { Usage } from './providers/index';
import { sendCommand } from './storage_client';

export interface ModelRates {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cachedInputUsdPerMTok?: number;
}

export const CACHED_INPUT_USD_PER_MTOK = 0.15;

export const MUSE_SPARK_RATE: ModelRates = {
  inputUsdPerMTok: 1.25,
  outputUsdPerMTok: 4.25,
  cachedInputUsdPerMTok: CACHED_INPUT_USD_PER_MTOK,
};

export const WEB_SEARCH_COST_USD = 0.0025;
export const SAM_IMAGE_COST_USD = 0.0025;

export const cachedInputTokensOf = (usage: Usage): number =>
  Math.min(Math.max(0, usage.cachedInputTokens ?? 0), Math.max(0, usage.inputTokens));

const cachedRateOf = (rates: ModelRates): number =>
  rates.cachedInputUsdPerMTok ?? rates.inputUsdPerMTok;

export const estimateCostUsd = (usage: Usage, rates: ModelRates): number => {
  const cached = cachedInputTokensOf(usage);

  const tokens =
    ((usage.inputTokens - cached) * rates.inputUsdPerMTok +
      cached * cachedRateOf(rates) +
      usage.outputTokens * rates.outputUsdPerMTok) /
    1_000_000;

  return tokens + usage.searchCount * WEB_SEARCH_COST_USD + usage.flatFeesUsd;
};

const COST_TOTALS_KEY = 'costTotals';

const MAX_MONTHS_KEPT = 24;

const SPEND_VERSION = 1;

interface SpendRecord {
  v: number;
  months: Record<string, number>;
}

export const migrateSpend = async (): Promise<void> => {
  const stored = (await chrome.storage.local.get(COST_TOTALS_KEY)) as {
    costTotals?: unknown;
  };

  const record = stored.costTotals;

  if (!record || typeof record !== 'object' || Array.isArray(record) || 'v' in record) {
    return;
  }

  const months: Record<string, number> = {};

  for (const [month, total] of Object.entries(record as Record<string, unknown>)) {
    if (typeof total === 'number') {
      months[month] = total;
    }
  }

  const next: SpendRecord = { v: SPEND_VERSION, months };
  await chrome.storage.local.set({ [COST_TOTALS_KEY]: next });
};

export const formatUsd = (amount: number): string => {
  if (!(amount > 0)) {
    return '$0.00';
  }

  return amount < 0.1 ? `$${amount.toFixed(3)}` : `$${amount.toFixed(2)}`;
};

export const monthKey = (date: Date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

// Storage failures throw so writers abort instead of persisting totals rebuilt from an empty read.
export const readTotals = async (): Promise<Record<string, number>> => {
  const stored = (await chrome.storage.local.get(COST_TOTALS_KEY)) as {
    costTotals?: unknown;
  };

  const record = stored.costTotals;

  if (record === undefined) {
    return {};
  }

  if (typeof record !== 'object' || record === null) {
    return {};
  }

  if (
    'v' in record &&
    (record as SpendRecord).v === SPEND_VERSION &&
    typeof (record as SpendRecord).months === 'object' &&
    (record as SpendRecord).months !== null
  ) {
    return { ...(record as SpendRecord).months };
  }

  if ('v' in record) {
    throw new Error(`unsupported spend record v${String((record as { v: unknown }).v)}`);
  }

  const months: Record<string, number> = {};

  for (const [month, total] of Object.entries(record as Record<string, unknown>)) {
    if (typeof total === 'number') {
      months[month] = total;
    }
  }

  return months;
};

export const writeTotals = async (totals: Record<string, number>): Promise<void> => {
  const keys = Object.keys(totals).sort().reverse();

  for (const old of keys.slice(MAX_MONTHS_KEPT)) {
    delete totals[old];
  }

  const record: SpendRecord = { v: SPEND_VERSION, months: totals };
  await chrome.storage.local.set({ [COST_TOTALS_KEY]: record });
};

export const recordMonthSpend = async (
  amountUsd: number,
  date: Date = new Date()
): Promise<number> => sendCommand<number>({ kind: 'spend.record', amountUsd, at: date.getTime() });

export const readMonthSpend = async (date: Date = new Date()): Promise<number> => {
  const totals = await readTotals();

  const value = totals[monthKey(date)];

  return typeof value === 'number' ? value : 0;
};
