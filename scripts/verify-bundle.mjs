// Post-build checks for the MV3 bundle: no eval-style code (the content
// security policy forbids it), zod/mini only in source (the full zod import
// doubles the schema weight), and the service worker bundle carries the
// serialized page scraper plus the menu wiring.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const dist = path.join(root, 'dist');

const files = readdirSync(dist).filter((f) => f.endsWith('.js'));

if (files.length === 0) {
  console.error('verify: no bundles in dist/');
  process.exit(1);
}

let failed = false;
// CSP forbids more than direct eval: constructed functions, string timers,
// and remote dynamic imports all fail at runtime under MV3.
const forbidden = [
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /setTimeout\s*\(\s*['"`]/,
  /setInterval\s*\(\s*['"`]/,
  /import\s*\(\s*['"`]https?:/,
];
for (const file of files) {
  const text = readFileSync(path.join(dist, file), 'utf8');
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      console.error(`verify: ${file} matches forbidden ${pattern} (MV3 blocks it)`);
      failed = true;
    }
  }
  console.log(`verify: ${file} ${(text.length / 1024).toFixed(1)} KB`);
}
const srcFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
    } else if (/\.[jt]sx?$/.test(name)) {
      srcFiles.push(full);
    }
  }
};
walk(path.join(root, 'src'));
for (const full of srcFiles) {
  const text = readFileSync(full, 'utf8');
  if (/from\s+['"]zod['"]/.test(text) || /require\s*\(\s*['"]zod['"]\s*\)/.test(text)) {
    console.error(`verify: ${path.relative(root, full)} imports bare zod (use zod/mini)`);
    failed = true;
  }
}
const worker = readFileSync(path.join(dist, 'service-worker.js'), 'utf8');
for (const marker of ['plan-trip', 'application/ld+json', 'imgFound', 'videoWidth', 'no-match']) {
  if (!worker.includes(marker)) {
    console.error(`verify: service-worker.js lacks expected marker: ${marker}`);
    failed = true;
  }
}
const panelCss = readFileSync(path.join(dist, 'sidepanel.css'), 'utf8');
for (const marker of [
  'skeleton-shimmer',
  '--focus-color',
  'scroll-padding-top',
  'grid-template-columns',
]) {
  if (!panelCss.includes(marker)) {
    console.error(`verify: sidepanel.css lacks expected marker: ${marker}`);
    failed = true;
  }
}
if (failed) {
  process.exit(1);
}
console.log('verify: bundles clean, worker carries menu wiring and scraper');
