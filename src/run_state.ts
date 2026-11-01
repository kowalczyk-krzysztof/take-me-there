// Async flows check ownsUi() after every await; superseded runs may settle usage but must never touch UI or cache.
import { recordMonthSpend, readMonthSpend, estimateCostUsd } from './pricing';
import {
  addUsage,
  emptyUsage,
  type ExtensionSettings,
  type Provider,
  type Usage,
} from './providers/index';
import type { PlaceResult, TripRequest } from './types';
import { createMutex } from './utils/mutex';

export type RunKind = 'identify' | 'video' | 'alternates';

export interface RunContext {
  readonly runId: string;
  readonly requestId: string;
  readonly kind: RunKind;
  readonly provider: Provider;
  readonly settings: ExtensionSettings;
  readonly key: string;
  readonly request: TripRequest | null;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly settle: (task: () => Promise<void>) => Promise<void>;
  place: PlaceResult | null;
  destination: string;
  cacheKey: string;
  usage: Usage;
  recordedUsd: number;
  settledStages: Set<string>;
  cancelled: boolean;
}

export interface RunInit {
  runId: string;
  requestId: string;
  kind: RunKind;
  provider: Provider;
  settings: ExtensionSettings;
  key: string;
  request: TripRequest | null;
  place?: PlaceResult | null;
  destination?: string;
  cacheKey?: string;
}

let active: RunContext | null = null;

let ephemeralCounter = 0;

export const activeRun = (): RunContext | null => active;

export const ownsUi = (run: RunContext): boolean => active === run && !run.cancelled;

export const cancelRun = (run: RunContext): void => {
  if (run.cancelled) {
    return;
  }

  run.cancelled = true;

  try {
    run.controller.abort();
  } catch {
    // Already aborted; the flag above is what guards follow-ups.
  }

  if (active === run) {
    active = null;
  }
};

export const cancelActiveRun = (): RunContext | null => {
  const run = active;

  if (run) {
    cancelRun(run);
  }

  return run;
};

export const createRun = (init: RunInit): RunContext => {
  const controller = new AbortController();

  return {
    runId: init.runId,
    requestId: init.requestId,
    kind: init.kind,
    provider: init.provider,
    settings: init.settings,
    key: init.key,
    request: init.request,
    controller,
    signal: controller.signal,
    settle: createMutex(),
    place: init.place ?? null,
    destination: init.destination ?? '',
    cacheKey: init.cacheKey ?? '',
    usage: emptyUsage(),
    recordedUsd: 0,
    settledStages: new Set(),
    cancelled: false,
  };
};

// Usage-only bucket: settles idempotently, never owns UI.
export const createEphemeralRun = (
  kind: RunKind,
  provider: Provider,
  settings: ExtensionSettings,
  key: string
): RunContext => {
  ephemeralCounter += 1;

  return createRun({
    runId: `ephemeral:${kind}:${ephemeralCounter}`,
    requestId: '',
    kind,
    provider,
    settings,
    key,
    request: null,
  });
};

export interface StartRunOptions {
  inheritFrom?: RunContext;
  abortSiblings?: () => void;
}

// Follow-ups inherit the usage snapshot so the run figure stays cumulative.
export const startRun = (init: RunInit, options: StartRunOptions = {}): RunContext => {
  if (active) {
    cancelRun(active);
  }

  options.abortSiblings?.();

  const run = createRun(init);

  if (options.inheritFrom) {
    run.usage = { ...options.inheritFrom.usage };
    run.recordedUsd = options.inheritFrom.recordedUsd;
  }

  active = run;

  return run;
};

export const absorbRunUsage = (run: RunContext, usage: Usage): void => {
  run.usage = addUsage(run.usage, usage);
};

// First settle of a (run, stage) records the unrecorded delta; repeats only re-read.
// A failed write leaves the watermark, so the next stage retries instead of losing the spend.
export const settleStage = async (run: RunContext, stage: string): Promise<number> => {
  let total = 0;

  await run.settle(async () => {
    const rates = run.provider.getRates();

    const usd = estimateCostUsd(run.usage, rates);

    const mark = `${run.runId}:${stage}`;

    if (!run.settledStages.has(mark)) {
      const delta = Math.max(0, usd - run.recordedUsd);

      if (delta > 0) {
        await recordMonthSpend(delta);
        run.recordedUsd = usd;
      }

      run.settledStages.add(mark);
    }

    total = await readMonthSpend();
  });

  return total;
};
