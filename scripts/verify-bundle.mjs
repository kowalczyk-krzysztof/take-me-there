// Post-build checks for the MV3 bundle: no eval-style code (the content
// security policy forbids it), and the service worker bundle carries the
// serialized page scraper plus the menu wiring.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist');
const files = readdirSync(dist).filter((f) => f.endsWith('.js'));
if (files.length === 0) {
  console.error('verify: no bundles in dist/');
  process.exit(1);
}
let failed = false;
for (const file of files) {
  const text = readFileSync(path.join(dist, file), 'utf8');
  if (text.includes('eval(')) {
    console.error(`verify: ${file} contains forbidden code (MV3 blocks it)`);
    failed = true;
  }
  console.log(`verify: ${file} ${(text.length / 1024).toFixed(1)} KB`);
}
const worker = readFileSync(path.join(dist, 'service-worker.js'), 'utf8');
for (const marker of ['plan-trip', 'application/ld+json', 'imgFound', 'videoWidth', 'no-match']) {
  if (!worker.includes(marker)) {
    console.error(`verify: service-worker.js lacks expected marker: ${marker}`);
    failed = true;
  }
}
const panelCss = readFileSync(path.join(dist, 'sidepanel.css'), 'utf8');
for (const marker of ['skeleton-shimmer', '--focus-color', 'scroll-padding-top', 'grid-template-columns']) {
  if (!panelCss.includes(marker)) {
    console.error(`verify: sidepanel.css lacks expected marker: ${marker}`);
    failed = true;
  }
}
if (failed) {
  process.exit(1);
}
console.log('verify: bundles clean, worker carries menu wiring and scraper');
