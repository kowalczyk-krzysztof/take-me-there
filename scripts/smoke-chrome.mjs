// Real-Chrome execution-boundary smoke: boots the built extension pages in
// headless Chrome, fails on console/page errors, and checks narrow, dark,
// and reduced-motion rendering. No API key needed; keyed flows stay manual
// in docs/browser-smoke.md. Zero dependencies: raw CDP over fetch/WebSocket.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = resolve(process.argv[2] ?? 'dist');

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const findChrome = async () => {
  const { access } = await import('node:fs/promises');

  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('no Chrome binary found; set CHROME_PATH');
};

const waitForJson = async (url, timeoutMs) => {
  const started = Date.now();

  for (;;) {
    try {
      const res = await fetch(url);

      if (res.ok) {
        return await res.json();
      }
    } catch {
      // Chrome is still starting.
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${url}`);
    }
    await sleep(200);
  }
};

const connectTarget = (wsUrl) =>
  new Promise((resolveWs, rejectWs) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));

      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolveMsg, rejectMsg } = pending.get(msg.id);
        pending.delete(msg.id);

        if (msg.error) {
          rejectMsg(new Error(msg.error.message));
        } else {
          resolveMsg(msg.result);
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        ws.dispatchEvent(new CustomEvent('page-error', { detail: msg.params }));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        ws.dispatchEvent(new CustomEvent('page-error', { detail: msg.params }));
      } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        ws.dispatchEvent(new CustomEvent('log-entry', { detail: msg.params.entry }));
      }
    });

    ws.addEventListener('open', () => {
      resolveWs({
        send: (method, params = {}, timeoutMs = 10000) =>
          new Promise((resolveMsg, rejectMsg) => {
            const id = nextId;
            nextId += 1;
            pending.set(id, { resolveMsg, rejectMsg });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
              if (pending.delete(id)) {
                rejectMsg(new Error(`CDP ${method} timed out`));
              }
            }, timeoutMs);
          }),
        onPageError: (fn) => ws.addEventListener('page-error', (event) => fn(event.detail)),
        onLogEntry: (fn) => ws.addEventListener('log-entry', (event) => fn(event.detail)),
        close: () => ws.close(),
      });
    });
    ws.addEventListener('error', rejectWs);
  });

export const failures = [];

export const check = (name, ok, extra = '') => {
  console.log(`smoke-chrome: ${ok ? 'ok' : 'FAILED'} ${name}${extra ? ` (${extra})` : ''}`);

  if (!ok) {
    failures.push(name);
  }
};

export { connectTarget, waitForJson };

const main = async () => {
  const chrome = await findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'tmt-smoke-'));
  const port = 18711;

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  try {
    // Load through CDP: --load-extension is ignored by headless Chrome, and
    // /json/list is crowded with component extensions, so take the id from
    // the load call instead of sniffing targets.
    const version = await waitForJson(`http://127.0.0.1:${port}/json/version`, 30000);
    const browserSession = await connectTarget(version.webSocketDebuggerUrl);

    let extensionId = '';

    try {
      ({ id: extensionId } = await browserSession.send('Extensions.loadUnpacked', {
        path: dist,
      }));
    } catch (error) {
      check('extension loads in Chrome', false, String(error));
      throw error;
    }
    browserSession.close();
    check('extension loads in Chrome', Boolean(extensionId));

    if (!extensionId) {
      throw new Error('extension id missing');
    }

    const openPage = async (page) => {
      const created = await (
        await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, {
          method: 'PUT',
        })
      ).json();

      const session = await connectTarget(created.webSocketDebuggerUrl);
      const errors = [];
      session.onPageError((detail) => {
        const fromException = detail.exceptionDetails?.text;
        const fromConsole = detail.args?.map((arg) => arg.value ?? arg.description ?? '').join(' ');
        errors.push(fromException ?? fromConsole ?? 'page error');
      });
      session.onLogEntry((entry) => {
        errors.push(`${entry.source ?? 'log'}: ${entry.text ?? entry.url ?? 'error'}`);
      });
      await session.send('Runtime.enable');
      await session.send('Log.enable');
      await session.send('Page.enable');
      await session.send('Page.navigate', {
        url: `chrome-extension://${extensionId}/${page}`,
      });

      return { session, errors };
    };

    const evaluate = async (session, expression) => {
      const { result } = await session.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });

      if (result.type === 'string') {
        return result.value;
      }

      return result.value ?? result.description ?? null;
    };

    const waitFor = async (session, expression, timeoutMs = 10000) => {
      const started = Date.now();

      for (;;) {
        if (await evaluate(session, expression)) {
          return true;
        }

        if (Date.now() - started > timeoutMs) {
          return false;
        }
        await sleep(200);
      }
    };

    const dumpPage = async (session) =>
      evaluate(
        session,
        `location.href + ' | readyState=' + document.readyState + ' | scripts=' + document.scripts.length + ' | root=' + (document.getElementById('root')?.innerHTML.length ?? -1)`
      );

    const { session: panel, errors: panelErrors } = await openPage('sidepanel.html');
    const panelLoaded = await waitFor(panel, `document.readyState === 'complete'`);
    const panelDump = String(await dumpPage(panel));
    check(
      'sidepanel loads',
      panelLoaded && panelDump.includes(extensionId) && panelDump.includes('sidepanel.html'),
      panelDump
    );
    check('sidepanel boots without page errors', panelErrors.length === 0, panelErrors[0] ?? '');
    check(
      'sidepanel renders tabs and idle hint',
      await waitFor(
        panel,
        `document.querySelectorAll('#tab-bar [role="tab"]').length === 2 && document.querySelector('#result-slot #idle-hint') !== null`
      )
    );

    await evaluate(panel, `document.querySelector('#tab-settings').click()`);
    check(
      'settings shows key, modes, data, and cost cards',
      await waitFor(panel, `document.querySelectorAll('#settings-panel .panel-card').length === 4`)
    );

    await panel.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(500);
    check(
      'narrow panel keeps settings usable without sideways scroll',
      (await evaluate(
        panel,
        `document.querySelector('#retention-select') !== null && document.querySelector('#retention-select').offsetParent !== null && document.documentElement.scrollWidth <= window.innerWidth + 1`
      )) === true
    );

    await panel.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
    check(
      'dark theme applies',
      (await evaluate(panel, `matchMedia('(prefers-color-scheme: dark)').matches`)) === true
    );

    await panel.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    check(
      'reduced motion applies',
      (await evaluate(panel, `matchMedia('(prefers-reduced-motion: reduce)').matches`)) === true
    );
    panel.close();

    const { session: onboard, errors: onboardErrors } = await openPage('onboarding.html');
    const onboardLoaded = await waitFor(onboard, `document.readyState === 'complete'`);
    const onboardDump = String(await dumpPage(onboard));
    check(
      'onboarding loads',
      onboardLoaded && onboardDump.includes(extensionId) && onboardDump.includes('onboarding.html'),
      onboardDump
    );
    check(
      'onboarding boots without page errors',
      onboardErrors.length === 0,
      onboardErrors[0] ?? ''
    );
    check(
      'onboarding renders the key form',
      await waitFor(
        onboard,
        `document.querySelector('#key-host #key-input') !== null && document.querySelector('#key-host button[type="submit"]') !== null`
      )
    );
    onboard.close();
  } finally {
    const exited = new Promise((resolve) => child.once('exit', resolve));

    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }

    await Promise.race([exited, sleep(5000)]);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(profile, { recursive: true, force: true });

        break;
      } catch {
        await sleep(500);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`smoke-chrome: ${failures.length} failing checks`);
    process.exitCode = 1;

    return;
  }

  console.log('smoke-chrome: all checks passed');
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
