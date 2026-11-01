// Serialized injected functions must run in a fresh page context with no
// bundle scope. Builds each injected module with the real toolchain in
// development and production modes, then executes the serialized source in a
// bare VM context with stubbed DOM.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { Window } from 'happy-dom';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const CHECKS = [
  { name: 'fetchImageAsDataUrl', file: 'fetch_image_bytes.ts' },
  { name: 'collectSignals', file: 'collect_signals.ts' },
  { name: 'captureVideoFrame', file: 'capture_video_frame.ts' },
];

const run = async (cmd, args, env = {}) => {
  try {
    return await execFileAsync(cmd, args, {
      cwd: root,
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${err.stdout ?? ''}\n${err.stderr ?? ''}`);
  }
};

const buildSerialized = async (check, mode) => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-injected-'));
  const entry = join(dir, 'entry.ts');
  const outFile = join(dir, 'serialized.txt');
  const bundle = join(dir, 'bundle');
  const configFile = join(dir, 'rspack.config.mjs');

  writeFileSync(
    entry,
    `import { writeFileSync } from 'node:fs';\n` +
      `import { ${check.name} } from ${JSON.stringify(join(root, 'src', 'injected', check.file))};\n` +
      `writeFileSync(process.env.TMT_OUT as string, ${check.name}.toString());\n`
  );
  writeFileSync(
    configFile,
    `export default {\n` +
      `  mode: ${JSON.stringify(mode)},\n` +
      `  context: ${JSON.stringify(root)},\n` +
      `  target: 'node',\n` +
      `  entry: { check: ${JSON.stringify(entry)} },\n` +
      `  output: { path: ${JSON.stringify(bundle)}, filename: '[name].js', clean: true },\n` +
      `  resolve: { extensions: ['.ts', '.js'] },\n` +
      `  module: { rules: [{ test: /\\.ts$/, loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' } } }] },\n` +
      `};\n`
  );

  const rspackBin = join(root, 'node_modules', '@rspack', 'cli', 'bin', 'rspack.js');
  await run(process.execPath, [rspackBin, 'build', '--config', configFile], { TMT_OUT: outFile });
  await run(process.execPath, [join(bundle, 'check.js')], { TMT_OUT: outFile });

  return readFileSync(outFile, 'utf8');
};

const baseSandbox = () => ({
  setTimeout,
  clearTimeout,
  AbortController,
  Response,
  Headers,
  ReadableStream,
  TextEncoder,
  TextDecoder,
  Blob,
  DOMException,
  URL,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  console,
});

const freshDocument = (html, url) => {
  const window = new Window({ url });

  window.document.write(html);

  return { document: window.document, location: window.location };
};

const CHECK_RUNNERS = {
  fetchImageAsDataUrl: async (fn) => {
    const fetch = async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    const sandbox = { ...baseSandbox(), fetch };

    vm.createContext(sandbox);

    const run = vm.runInContext(`(${fn})`, sandbox);
    const outcome = await run('https://cdn.example.com/oia.jpg', 1000, 30_000);

    if (outcome?.ok !== true || outcome.dataUrl !== 'data:image/jpeg;base64,AQID') {
      throw new Error(`unexpected outcome: ${JSON.stringify(outcome)}`);
    }
  },

  collectSignals: async (fn) => {
    const { document, location } = freshDocument(
      `<!doctype html><html><head><title>Oia trip</title>` +
        `<link rel="canonical" href="https://example.com/travel/oia">` +
        `<meta property="og:title" content="Oia">` +
        `<script type="application/ld+json">{"@type":"Place","name":"Oia"}</script>` +
        `</head><body><h1>Santorini</h1>` +
        `<img src="https://cdn.example.com/oia.jpg" alt="Blue domes">` +
        `</body></html>`,
      'https://example.com/travel/oia-guide?x=1'
    );
    const sandbox = { ...baseSandbox(), document, location };

    vm.createContext(sandbox);

    const run = vm.runInContext(`(${fn})`, sandbox);
    const signals = run('https://cdn.example.com/oia.jpg');

    if (signals?.imgFound !== true || signals?.alt !== 'Blue domes') {
      throw new Error(`unexpected signals: ${JSON.stringify(signals)}`);
    }
  },

  captureVideoFrame: async (fn) => {
    const { document } = freshDocument(
      '<!doctype html><html><body></body></html>',
      'https://example.com/vlog'
    );

    const video = document.createElement('video');
    document.body.append(video);
    Object.defineProperty(video, 'currentSrc', {
      value: 'https://cdn.example.com/clip.mp4',
      configurable: true,
    });
    Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true });
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(video, 'currentTime', { value: 12.5, configurable: true });
    Object.defineProperty(video, 'mediaKeys', { value: null, configurable: true });

    const realCreateElement = document.createElement.bind(document);
    document.createElement = (tag) => {
      const el = realCreateElement(tag);

      if (tag === 'canvas') {
        el.getContext = () => ({ drawImage: () => undefined });
        el.toDataURL = () => 'data:image/jpeg,small';
      }

      return el;
    };

    const sandbox = { ...baseSandbox(), document };

    vm.createContext(sandbox);

    const run = vm.runInContext(`(${fn})`, sandbox);
    const outcome = run('https://cdn.example.com/clip.mp4');

    if (outcome?.ok !== true || typeof outcome?.dataUrl !== 'string') {
      throw new Error(`unexpected outcome: ${JSON.stringify(outcome)}`);
    }

    const miss = run('https://cdn.example.com/other.mp4');

    if (miss?.ok !== false || miss?.reason !== 'no-match') {
      throw new Error(`unexpected miss: ${JSON.stringify(miss)}`);
    }
  },
};

let failed = false;

for (const check of CHECKS) {
  for (const mode of ['development', 'production']) {
    try {
      const source = await buildSerialized(check, mode);
      await CHECK_RUNNERS[check.name](source);
      console.log(`verify-injected: ${check.name} (${mode}) ok`);
    } catch (err) {
      failed = true;
      console.error(`verify-injected: ${check.name} (${mode}) FAILED: ${err.message}`);
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log('verify-injected: all serialized functions execute in fresh contexts');
