// QA screenshot harness for section 8. Generates file:// pages from the
// production dist/ bundles with a minimal chrome API stub, screenshots
// them with headless Chrome, and audits each shot for horizontal overflow
// and clipped primary actions.
//
// Usage: npm run build && node docs/qa/harness.mjs [--out /tmp/qa]
// Requires headless Chrome (CHROME_BIN or macOS default path).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outIndex = process.argv.indexOf('--out');
const outDir = outIndex === -1 ? '/tmp/qa' : process.argv[outIndex + 1];

const CHROME =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const messages = JSON.parse(readFileSync(join(root, 'public/_locales/en/messages.json'), 'utf8'));

const stub = (messagesJson) => `
const QA_PARAMS = new URLSearchParams(location.search);
const QA_MESSAGES = ${messagesJson};

const qaSubst = (template, subs) => {
  const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
  return template.replace(/\\$(\\d+)/g, (_, n) => String(list[Number(n) - 1] ?? ''));
};

const qaArea = () => {
  const data = new Map();
  const listeners = new Set();
  return {
    data,
    listeners,
    get: async (keys) => {
      if (keys === null || keys === undefined) return Object.fromEntries(data);
      if (typeof keys === 'string') return data.has(keys) ? { [keys]: data.get(keys) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) if (data.has(key)) out[key] = data.get(key);
        return out;
      }
      const out = { ...keys };
      for (const key of Object.keys(keys)) if (data.has(key)) out[key] = data.get(key);
      return out;
    },
    set: async (items) => {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data.get(key), newValue: value };
        data.set(key, structuredClone(value));
      }
      queueMicrotask(() => {
        for (const fn of listeners) fn(structuredClone(changes));
      });
    },
    remove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        changes[key] = { oldValue: data.get(key), newValue: undefined };
        data.delete(key);
      }
      queueMicrotask(() => {
        for (const fn of listeners) fn(structuredClone(changes));
      });
    },
    onChanged: {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
    },
  };
};

const qaLocal = qaArea();
const qaSession = qaArea();

const QA_SEEDS = {
  board2: {
    tripBoard: {
      v: 1,
      pins: [
        {
          place: {
            identified: true,
            placeName: 'Oia',
            city: 'Oia',
            country: 'Greece',
            confidence: 0.9,
            oneLiner: 'Blue domes over the caldera.',
          },
          sourceHost: 'example.com',
          addedAt: 1,
        },
        {
          place: {
            identified: true,
            placeName: 'Fira',
            city: 'Fira',
            country: 'Greece',
            confidence: 0.88,
            oneLiner: 'White lanes above the caldera.',
          },
          sourceHost: 'blog.example',
          addedAt: 2,
        },
      ],
    },
  },
  board2stale: {
    tripBoard: {
      v: 1,
      pins: [
        {
          place: {
            identified: true,
            placeName: 'Fira',
            city: 'Fira',
            country: 'Greece',
            confidence: 0.88,
            oneLiner: 'White lanes above the caldera.',
          },
          sourceHost: 'blog.example',
          addedAt: 1,
        },
        {
          place: {
            identified: true,
            placeName: 'Imerovigli',
            city: 'Imerovigli',
            country: 'Greece',
            confidence: 0.81,
            oneLiner: 'Quiet caldera views.',
          },
          sourceHost: 'photos.example',
          addedAt: 2,
        },
      ],
    },
    tripItinerary: {
      v: 1,
      pinIds: ['mismatched', 'identities'],
      markdown: '## Day 1\\n\\nWander Oia.',
      plannedAt: 1,
    },
  },
};

{
  const seed = QA_SEEDS[QA_PARAMS.get('seed') ?? ''];
  if (seed) {
    for (const [key, value] of Object.entries(seed)) {
      qaLocal.data.set(key, structuredClone(value));
    }
  }
}

const qaLang = QA_PARAMS.get('lang') ?? 'en';

globalThis.chrome = {
  storage: { local: qaLocal, session: qaSession },
  i18n: {
    getMessage: (key, subs) => {
      const entry = QA_MESSAGES[key];
      if (!entry) return key;
      return qaSubst(entry.message, subs);
    },
    getUILanguage: () => qaLang,
  },
  runtime: {
    id: 'qa-harness',
    getURL: (path) => 'file://qa/' + path,
    sendMessage: async (message) => {
      console.warn('QA stub: unhandled sendMessage', JSON.stringify(message).slice(0, 200));
      throw new Error('QA stub has no service worker');
    },
    onMessage: { addListener: () => {}, removeListener: () => {} },
  },
  windows: { getCurrent: async () => ({ id: 1 }) },
  tabs: { query: async () => [] },
  commands: { getAll: async () => [] },
  permissions: {
    contains: async () => false,
    request: async () => false,
    remove: async () => {},
  },
  scripting: { executeScript: async () => { throw new Error('QA stub: no scripting'); } },
  contextMenus: { create: () => {}, removeAll: () => {}, onClicked: { addListener: () => {} } },
  sidePanel: { open: async () => {}, setPanelBehavior: async () => {} },
};

window.addEventListener('DOMContentLoaded', () => {
  window.setTimeout(() => {
    const tab = QA_PARAMS.get('tab');
    if (tab) {
      document.querySelector('#tab-' + tab)?.click();
    }
  }, 500);

  if (QA_PARAMS.get('guide') === 'sample') {
    window.setTimeout(() => {
      const slot = document.querySelector('#guide-slot');
      const content = document.querySelector('#guide-content');
      if (slot && content) {
        slot.hidden = false;
        content.setAttribute('lang', qaLang);
        content.innerHTML =
          '<h3>Sample guide content (QA harness)</h3>' +
          '<p>Blue domes over the caldera at golden hour.</p>' +
          '<ul><li>Walk the caldera path</li><li>Watch the sunset from Oia castle</li></ul>';
      }
    }, 900);
  }

  window.setTimeout(() => {
    const focus = QA_PARAMS.get('focus');
    if (focus) {
      document.querySelector(focus)?.focus({ preventScroll: false });
    }

    const el = document.documentElement;
    const overflowX = el.scrollWidth > el.clientWidth + 1;
    const probe = {
      innerWidth: window.innerWidth,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      tabbar: (() => {
        const bar = document.querySelector('#tab-bar');
        if (!bar) return null;
        const tabs = [...bar.querySelectorAll('[role=tab]')].map((t) => {
          const r = t.getBoundingClientRect();
          return [Math.round(r.left), Math.round(r.right), t.textContent?.trim()];
        });
        return { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth, tabs };
      })(),
      boardRows: [...document.querySelectorAll('#board-slot li')].map((li) => ({
        scrollWidth: li.scrollWidth,
        clientWidth: li.clientWidth,
      })),
    };
    const clipped = [...document.querySelectorAll('button')]
      .filter((b) => b.getClientRects().length > 0)
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width < 2 || r.height < 2 || r.left < 0 || r.right > el.clientWidth + 1;
      })
      .map((b) => b.textContent?.trim() ?? '?');
    const audit = document.createElement('p');
    audit.id = 'qa-audit';
    audit.hidden = true;
    audit.textContent = JSON.stringify({ overflowX, clipped, probe });
    document.body.append(audit);
    document.title = 'QA-READY';
  }, 1500);
});
`;

const PAGES = ['sidepanel', 'options', 'onboarding'];

const generate = () => {
  mkdirSync(outDir, { recursive: true });

  const stubJs = stub(JSON.stringify(messages));

  for (const page of PAGES) {
    const html = readFileSync(join(root, 'dist', `${page}.html`), 'utf8');

    if (!html.includes(`<script src="${page}.js"></script>`)) {
      throw new Error(`unexpected ${page}.html shape`);
    }

    const out = html.replace(
      `<script src="${page}.js"></script>`,
      `<script>${stubJs}</script>\n    <script src="${page}.js"></script>`
    );
    writeFileSync(join(outDir, `${page}.html`), out);
    writeFileSync(join(outDir, `${page}.js`), readFileSync(join(root, 'dist', `${page}.js`)));
    writeFileSync(join(outDir, `${page}.css`), readFileSync(join(root, 'dist', `${page}.css`)));
  }
};

const SHOTS = [
  { name: 'sidepanel-idle-320', page: 'sidepanel', params: '', width: 320, height: 700 },
  { name: 'sidepanel-idle-400', page: 'sidepanel', params: '', width: 400, height: 700 },
  { name: 'sidepanel-idle-520', page: 'sidepanel', params: '', width: 520, height: 700 },
  {
    name: 'sidepanel-board-320',
    page: 'sidepanel',
    params: 'seed=board2&tab=board',
    width: 320,
    height: 700,
  },
  {
    name: 'sidepanel-board-400',
    page: 'sidepanel',
    params: 'seed=board2&tab=board',
    width: 400,
    height: 700,
  },
  {
    name: 'sidepanel-board-520',
    page: 'sidepanel',
    params: 'seed=board2&tab=board',
    width: 520,
    height: 700,
  },
  {
    name: 'sidepanel-board-stale-400',
    page: 'sidepanel',
    params: 'seed=board2stale&tab=board',
    width: 400,
    height: 700,
  },
  {
    name: 'sidepanel-settings-400',
    page: 'sidepanel',
    params: 'tab=settings',
    width: 400,
    height: 700,
  },
  { name: 'options-520', page: 'options', params: '', width: 520, height: 700 },
  { name: 'onboarding-400', page: 'onboarding', params: '', width: 400, height: 700 },
  {
    name: 'sidepanel-board-400-dark',
    page: 'sidepanel',
    params: 'seed=board2&tab=board',
    width: 400,
    height: 700,
    dark: true,
  },
  {
    name: 'sidepanel-idle-400-dark',
    page: 'sidepanel',
    params: '',
    width: 400,
    height: 700,
    dark: true,
  },
  {
    name: 'sidepanel-board-400-zoom200',
    page: 'sidepanel',
    params: 'seed=board2&tab=board',
    width: 400,
    height: 700,
    scale: 2,
  },
  {
    name: 'sidepanel-idle-400-motion',
    page: 'sidepanel',
    params: '',
    width: 400,
    height: 700,
    motion: true,
  },
  {
    name: 'sidepanel-board-400-focus',
    page: 'sidepanel',
    params: 'seed=board2&tab=board&focus=.plan-button',
    width: 400,
    height: 700,
  },
  {
    name: 'sidepanel-guide-rtl-400',
    page: 'sidepanel',
    params: 'lang=ar&guide=sample',
    width: 400,
    height: 700,
  },
];

const CDP_PORT = 9222;

const cdpHttp = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`, init);
  return res.json();
};

const launchChrome = async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${CDP_PORT}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  for (let i = 0; i < 100; i++) {
    try {
      await cdpHttp('/json/version');
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  child.kill();
  throw new Error('Chrome CDP did not come up');
};

const connectTarget = (wsUrl) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

const shoot = async (shot, shotDir) => {
  const target = await cdpHttp(`/json/new?${encodeURI(shot.url)}`, { method: 'PUT' });
  const ws = await connectTarget(target.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  try {
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: shot.width,
      height: shot.height,
      deviceScaleFactor: shot.scale ?? 1,
      mobile: false,
    });
    await send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: shot.dark ? 'dark' : 'light' },
        { name: 'prefers-reduced-motion', value: shot.motion ? 'reduce' : 'no-preference' },
      ],
    });
    await send('Page.navigate', { url: shot.url });

    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const title = await send('Runtime.evaluate', { expression: 'document.title' });
      ready = title.result?.value === 'QA-READY';
    }

    if (!ready) {
      throw new Error(`QA never ready: ${shot.name}`);
    }

    const audit = await send('Runtime.evaluate', {
      expression: `document.querySelector('#qa-audit')?.textContent ?? '{}'`,
    });
    const png = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shotDir, `${shot.name}.png`), Buffer.from(png.data, 'base64'));

    return JSON.parse(audit.result?.value ?? '{}');
  } finally {
    ws.close();
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`, {
      method: 'PUT',
    }).catch(() => {});
  }
};

const main = async () => {
  if (!existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME}; set CHROME_BIN`);
  }

  generate();

  const shotDir = join(root, 'docs/qa');
  mkdirSync(shotDir, { recursive: true });

  const shots = SHOTS.map((shot) => ({
    ...shot,
    url: `file://${join(outDir, `${shot.page}.html`)}?${shot.params}`,
  }));

  const chrome = await launchChrome();

  try {
    const rows = [];
    for (const shot of shots) {
      const audit = await shoot(shot, shotDir);
      rows.push({ ...shot, ...audit });
      console.log(
        `${shot.name}: overflowX=${audit.overflowX} clipped=${JSON.stringify(audit.clipped)} ` +
          `viewport=${audit.probe?.innerWidth} scheme=${audit.probe?.scheme}`
      );
    }

    const failed = rows.filter(
      (r) =>
        r.overflowX !== false ||
        (r.clipped?.length ?? 1) > 0 ||
        r.probe?.innerWidth !== r.width ||
        r.probe?.scheme !== (r.dark ? 'dark' : 'light')
    );

    if (failed.length > 0) {
      console.error(`QA FAIL: ${failed.map((f) => f.name).join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('QA PASS: viewports exact, no overflow, no clipped buttons');
    }
  } finally {
    chrome.kill();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
