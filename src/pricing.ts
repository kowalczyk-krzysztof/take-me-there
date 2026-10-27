// Cost math and the monthly spend accumulator. Providers report normalized
// usage; this module prices it. Providers without a rate table (custom
// endpoints) yield null, and the UI shows token counts instead of dollars.
import type { Usage } from './providers/index';

export interface ModelRates {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

// muse-spark-1.3: $1.25 per 1M input tokens, $4.25 per 1M output tokens.
export const MUSE_SPARK_RATES: Record<string, ModelRates> = {
  'muse-spark-1.3': { inputUsdPerMTok: 1.25, outputUsdPerMTok: 4.25 },
};

// Web grounding bills per search query on top of tokens.
export const WEB_SEARCH_COST_USD = 0.0025;
// Flat fee per sam-3.1 image call (the stretch crop feature).
export const SAM_IMAGE_COST_USD = 0.0025;

export const estimateCostUsd = (usage: Usage, rates?: ModelRates): number | null => {
  if (!rates) {
    return null;
  }
  const tokens =
    (usage.inputTokens * rates.inputUsdPerMTok + usage.outputTokens * rates.outputUsdPerMTok) /
    1_000_000;
  return tokens + usage.searchCount * WEB_SEARCH_COST_USD + usage.flatFeesUsd;
};

const COST_TOTALS_KEY = 'costTotals';
const MAX_MONTHS_KEPT = 24;

export const formatUsd = (amount: number): string => {
  if (!(amount > 0)) {
    return '$0.00';
  }
  return amount < 0.1 ? `$${amount.toFixed(3)}` : `$${amount.toFixed(2)}`;
};

export const monthKey = (date: Date = new Date()): string => date.toISOString().slice(0, 7);

const readTotals = async (): Promise<Record<string, number>> => {
  try {
    const stored = (await chrome.storage.local.get(COST_TOTALS_KEY)) as {
      costTotals?: Record<string, number>;
    };
    if (stored.costTotals && typeof stored.costTotals === 'object') {
      return stored.costTotals;
    }
  } catch {
    // Corrupt totals reset to empty below.
  }
  return {};
};

export const recordMonthSpend = async (
  amountUsd: number,
  date: Date = new Date(),
): Promise<number> => {
  const totals = await readTotals();
  const key = monthKey(date);
  const next = (typeof totals[key] === 'number' ? totals[key] : 0) + amountUsd;
  totals[key] = next;
  const keys = Object.keys(totals).sort().reverse();
  for (const old of keys.slice(MAX_MONTHS_KEPT)) {
    delete totals[old];
  }
  await chrome.storage.local.set({ [COST_TOTALS_KEY]: totals });
  return next;
};

export const readMonthSpend = async (date: Date = new Date()): Promise<number> => {
  const totals = await readTotals();
  const value = totals[monthKey(date)];
  return typeof value === 'number' ? value : 0;
};

export const resetMonthSpend = async (date: Date = new Date()): Promise<void> => {
  const totals = await readTotals();
  delete totals[monthKey(date)];
  await chrome.storage.local.set({ [COST_TOTALS_KEY]: totals });
};
