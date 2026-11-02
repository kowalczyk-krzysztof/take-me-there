// Recognition eval: runs the 12-image corpus in scripts/recognition-eval-cases.json
// through the REAL provider code (same prompts, parsing, and confidence the
// extension uses) and scores identification quality. Needs Node 24+ (imports
// the TypeScript sources directly via type stripping) and a live key:
//
//   MUSE_EVAL_KEY=LLM_... npm run eval:recognition
//
// Without a key it runs the keyless preflight only (corpus URLs reachable,
// case shapes valid) and exits 2. Results land in
// docs/recognition-eval-results.json as the recorded evidence; confidence
// bands in docs/recognition-eval.md are set from those results, never from
// this script's defaults.
import { readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

register('./ts-extension-loader.mjs', import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The operator runs this explicitly with their own key, so consent is granted
// by the act of running; the stub only satisfies the provider's consent gate.
// Nothing here changes product behavior.
const installChromeStub = () => {
  const stores = { local: new Map(), session: new Map() };
  stores.local.set('consentGiven', { v: 3 });

  const area = (store) => ({
    get: async (keys) => {
      if (keys === null || keys === undefined) return Object.fromEntries(store);
      if (typeof keys === 'string') {
        return store.has(keys) ? { [keys]: store.get(keys) } : {};
      }
      const out = {};
      for (const key of Array.isArray(keys) ? keys : Object.keys(keys)) {
        if (store.has(key)) out[key] = store.get(key);
      }
      return out;
    },
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value);
    },
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
  });

  globalThis.chrome = {
    storage: { local: area(stores.local), session: area(stores.session) },
    runtime: {
      sendMessage: async () => {
        throw new Error('eval harness has no worker transport');
      },
    },
  };
};

installChromeStub();

const [{ MuseProvider }, providerIndex, { PAGE_SIGNALS_SCHEMA }, pricing] = await Promise.all([
  import('../src/providers/muse.ts'),
  import('../src/providers/index.ts'),
  import('../src/types.ts'),
  import('../src/pricing.ts'),
]);

const { ProviderError, formatSignalsForPrompt } = providerIndex;
const { estimateCostUsd, formatUsd, MUSE_SPARK_RATE } = pricing;

const main = async () => {
  const MATCH_CONFIDENCE = 0.6;

  const casesPath = join(root, 'scripts', 'recognition-eval-cases.json');
  const resultsPath = join(root, 'docs', 'recognition-eval-results.json');

  const cases = JSON.parse(readFileSync(casesPath, 'utf8')).cases;

  const failures = [];

  const check = (name, ok, extra = '') => {
    console.log(`recognition-eval: ${ok ? 'ok' : 'FAILED'} ${name}${extra ? ` (${extra})` : ''}`);
    if (!ok) failures.push(name);
  };

  const blankSignals = () => ({
    imgFound: true,
    alt: '',
    imgTitle: '',
    figcaption: '',
    nearestHeading: '',
    nearestParagraph: '',
    ogTitle: '',
    ogDescription: '',
    ogSiteName: '',
    docTitle: '',
    metaDescription: '',
    canonical: '',
    pageHost: '',
    urlSlug: '',
    imgFileSlug: '',
    jsonLd: [],
  });

  const normalizeCase = (entry) => {
    for (const field of ['id', 'label', 'imageUrl', 'signals', 'expect']) {
      if (entry[field] === undefined) throw new Error(`case is missing ${field}`);
    }
    return {
      ...entry,
      signals: PAGE_SIGNALS_SCHEMA.parse({ ...blankSignals(), ...entry.signals }),
    };
  };

  const normalized = cases.map((entry) => {
    try {
      return { ok: true, entry: normalizeCase(entry) };
    } catch (err) {
      return { ok: false, entry, error: String(err) };
    }
  });

  for (const item of normalized) {
    check(`case ${item.entry.id ?? '?'} has a valid shape`, item.ok, item.ok ? '' : item.error);
  }

  if (failures.length > 0) {
    console.error(`recognition-eval: ${failures.length} invalid cases`);
    process.exitCode = 1;
    return;
  }

  const preflightOne = async (entry) => {
    if (entry.preflight?.skip) return `preflight ${entry.id} skipped`;
    const want = entry.preflight?.status ?? 200;
    let last = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(3000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(entry.imageUrl, { method: 'HEAD', signal: controller.signal });
        const type = res.headers.get('content-type') ?? '';
        last = `${res.status} ${type}`;
        if (res.status === 429) continue;
        const ok = res.status === want && (want !== 200 || type.startsWith('image/'));
        check(
          `preflight ${entry.id} serves ${want === 200 ? 'an image' : want}`,
          ok,
          ok ? '' : last
        );
        return;
      } catch (err) {
        last = String(err);
      } finally {
        clearTimeout(timer);
      }
    }
    check(`preflight ${entry.id} serves ${want === 200 ? 'an image' : want}`, false, last);
  };

  const seen = new Set();
  for (const item of normalized) {
    if (item.entry.preflight?.skip || seen.has(item.entry.imageUrl)) continue;
    seen.add(item.entry.imageUrl);
    await preflightOne(item.entry);
    await sleep(750);
  }

  if (failures.length > 0) {
    console.error(`recognition-eval: ${failures.length} preflight failures`);
    process.exitCode = 1;
    return;
  }
  console.log('recognition-eval: preflight passed (corpus reachable, shapes valid)');

  const key = process.env.MUSE_EVAL_KEY ?? '';

  if (!key) {
    console.log(
      'recognition-eval: set MUSE_EVAL_KEY to run the live eval (about a dozen identify calls, a few cents).'
    );
    process.exitCode = 2;
    return;
  }

  const provider = new MuseProvider();

  try {
    await provider.testKey(key);
    console.log('recognition-eval: key accepted');
  } catch (err) {
    console.error(`recognition-eval: key rejected (${err instanceof Error ? err.message : err})`);
    process.exitCode = 2;
    return;
  }

  const { scoreVerdict } = await import('./recognition-eval-scoring.mjs');

  const score = (entry, outcome) => scoreVerdict(entry.expect, outcome, MATCH_CONFIDENCE);

  const results = [];

  for (const { entry } of normalized) {
    const signalsText = formatSignalsForPrompt(entry.signals, false);
    let outcome;
    try {
      const result = await provider.identifyPlace(key, {
        imageUrl: entry.imageUrl,
        signalsText,
        signal: AbortSignal.timeout(120000),
      });
      outcome = {
        identified: result.place.identified,
        placeName: result.place.placeName,
        city: result.place.city,
        country: result.place.country,
        confidence: result.place.confidence,
        textFallback: result.textFallback ?? false,
        usage: result.usage,
      };
    } catch (err) {
      outcome = {
        error:
          err instanceof ProviderError
            ? `${err.code}${err.status ? `:${err.status}` : ''}${err.retryable ? ' (retryable)' : ''}`
            : String(err),
      };
    }
    const verdict = score(entry, outcome);
    results.push({ id: entry.id, label: entry.label, expect: entry.expect, outcome, verdict });
    const detail = outcome.error
      ? outcome.error
      : `${outcome.identified ? `${outcome.placeName}, ${outcome.city}, ${outcome.country}` : 'unidentified'} @ ${outcome.confidence}${outcome.textFallback ? ' (text fallback)' : ''}`;
    console.log(`recognition-eval: [${verdict}] ${entry.id}: ${detail}`);
    await sleep(1000);
  }

  const totalUsage = results.reduce(
    (sum, row) => ({
      inputTokens: sum.inputTokens + (row.outcome.usage?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (row.outcome.usage?.outputTokens ?? 0),
      cachedInputTokens: sum.cachedInputTokens + (row.outcome.usage?.cachedInputTokens ?? 0),
      searchCount: sum.searchCount + (row.outcome.usage?.searchCount ?? 0),
      flatFeesUsd: sum.flatFeesUsd + (row.outcome.usage?.flatFeesUsd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, searchCount: 0, flatFeesUsd: 0 }
  );

  const summary = {
    pass: results.filter((row) => row.verdict === 'pass').length,
    fail: results.filter((row) => row.verdict === 'fail').length,
    confidentIncorrect: results.filter((row) => row.verdict === 'confident-incorrect').length,
    error: results.filter((row) => row.verdict === 'error').length,
    review: results.filter((row) => row.verdict === 'review').length,
    usage: totalUsage,
    estimatedCostUsd: estimateCostUsd(totalUsage, MUSE_SPARK_RATE),
  };

  const record = {
    date: new Date().toISOString(),
    model: provider.modelName,
    corpus: 'scripts/recognition-eval-cases.json',
    matchConfidence: MATCH_CONFIDENCE,
    summary,
    results,
  };

  writeFileSync(resultsPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `recognition-eval: ${summary.pass} pass, ${summary.fail} fail, ` +
      `${summary.confidentIncorrect} confident-incorrect, ${summary.error} error, ` +
      `${summary.review} needs-review; run cost ${formatUsd(summary.estimatedCostUsd)}`
  );
  console.log(`recognition-eval: evidence written to docs/recognition-eval-results.json`);

  if (summary.fail + summary.confidentIncorrect + summary.error > 0) {
    process.exitCode = 1;
  }
};

await main();
