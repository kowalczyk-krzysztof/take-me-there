import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MUSE_SPARK_RATES,
  estimateCostUsd,
  readMonthSpend,
  recordMonthSpend,
  resetMonthSpend,
} from './pricing';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('pricing', () => {
  it('prices tokens, searches, and flat fees', () => {
    const rates = MUSE_SPARK_RATES['muse-spark-1.3'];
    expect(
      estimateCostUsd(
        { inputTokens: 1_000_000, outputTokens: 1_000_000, searchCount: 0, flatFeesUsd: 0 },
        rates,
      ),
    ).toBeCloseTo(5.5, 10);
    expect(
      estimateCostUsd(
        { inputTokens: 0, outputTokens: 0, searchCount: 2, flatFeesUsd: 0.0025 },
        rates,
      ),
    ).toBeCloseTo(0.0075, 10);
  });

  it('returns null without a rate table so the UI shows tokens', () => {
    expect(
      estimateCostUsd({ inputTokens: 10, outputTokens: 10, searchCount: 0, flatFeesUsd: 0 }),
    ).toBeNull();
  });

  it('accumulates, reads, and resets the monthly total', async () => {
    const day = new Date('2026-03-15T12:00:00Z');
    expect(await recordMonthSpend(0.5, day)).toBeCloseTo(0.5, 10);
    expect(await recordMonthSpend(0.25, day)).toBeCloseTo(0.75, 10);
    expect(await readMonthSpend(day)).toBeCloseTo(0.75, 10);
    expect(await readMonthSpend(new Date('2026-04-01T00:00:00Z'))).toBe(0);
    await resetMonthSpend(day);
    expect(await readMonthSpend(day)).toBe(0);
  });

  it('prunes totals to the most recent 24 months', async () => {
    for (let n = 0; n < 25; n += 1) {
      await recordMonthSpend(0.01, new Date(Date.UTC(2024, n, 2)));
    }
    const totals = mock.local.data.get('costTotals') as Record<string, number>;
    expect(Object.keys(totals)).toHaveLength(24);
    expect(totals['2024-01']).toBeUndefined();
    expect(totals['2026-01']).toBe(0.01);
  });
});
