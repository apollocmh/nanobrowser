// Unattended run of the test extension's checks and scenarios, for development.
//
//   node fixtures/autorun.mjs <check>[,<check>...] [--args '<json>'] [--headful] [--no-build] [--timeout <s>]
//                             [--scale <device scale factor>] [--product-permissions]
//
// It builds the extension into .output/autorun with WXT_AUTORUN_URL set, starts the fixture server with one
// queued job, and starts Chrome for Testing as a plain process with the extension loaded. The extension asks the
// server for the job, runs it in its service worker and posts the reports back. Nothing connects to Chrome over
// CDP: the only CDP client is the extension itself, through chrome.debugger.
//
// The autorun build requires the permissions the product only asks for (tab groups, notifications, downloads), so the
// checks that use them run without a click. --product-permissions builds with the product's lists instead, into
// .output/autorun-product, for the checks of the features without them (`without-permissions`); the checks that need
// the permissions (`panel-tabs`, `panel-save`, ...) are not run with it.
//
// The check `permission-warnings` gets the old Nanobrowser's manifest (fixtures/upgrade/old-manifest.json) in its
// arguments.
//
// Chrome: CHROME_PATH, or the stable Chrome for Testing that pnpm install-chrome put in ~/.cache/puppeteer/chrome.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { autorunEvents, PORT, queueAutorunJob, startServer } from './server.mjs';
import { findChrome } from './find-chrome.mjs';

const root = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const names = (
  argv.find(
    a =>
      !a.startsWith('--') &&
      !['--args', '--args-file', '--timeout', '--scale', '--chrome'].includes(argv[argv.indexOf(a) - 1]),
  ) ?? ''
)
  .split(',')
  .filter(Boolean);
if (!names.length) {
  console.error('usage: node fixtures/autorun.mjs <check>[,<check>...] [--args <json>] [--headful] [--no-build]');
  process.exit(2);
}
// A JSON file avoids .cmd quoting differences on Windows; accept PowerShell's UTF-8 BOM as well.
const args = option('--args-file')
  ? JSON.parse(readFileSync(resolve(root, option('--args-file')), 'utf8').replace(/^\uFEFF/, ''))
  : option('--args')
    ? JSON.parse(option('--args'))
    : {};
const timeoutMs = Number(option('--timeout') ?? 300) * 1000;
const base = `http://localhost:${PORT}`;
const productPermissions = flag('--product-permissions');
const legacy = flag('--mv2');
const outDir = join(root, '.output', `autorun${legacy ? '-mv2' : ''}${productPermissions ? '-product' : ''}`);

if (!flag('--no-build')) {
  // Use WXT's installed JS entry point: Windows cannot exec a .cmd shim directly.
  const wxtBin = join(root, 'node_modules', 'wxt', 'bin', 'wxt.mjs');
  execFileSync(process.execPath, [wxtBin, 'build', ...(legacy ? ['--mv2'] : [])], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      WXT_AUTORUN_URL: base,
      ...(legacy ? { WXT_LEGACY: '1' } : {}),
      ...(productPermissions ? { WXT_PRODUCT_PERMISSIONS: '1' } : {}),
    },
  });
}

const server = await startServer();
const argsOf = name =>
  name === 'permission-warnings'
    ? { ...args, oldManifest: JSON.parse(readFileSync(join(root, 'fixtures', 'upgrade', 'old-manifest.json'), 'utf8')) }
    : args;
queueAutorunJob({ checks: names.map(name => ({ name, args: argsOf(name) })) });

const profile = mkdtempSync(join(tmpdir(), 'nb3-autorun-'));
const chromeArgs = [
  `--user-data-dir=${profile}`,
  `--load-extension=${outDir}`,
  `--disable-extensions-except=${outDir}`,
  // Chrome for Testing never touches the real macOS Keychain: it keeps its passwords and cookies' key in a mock one.
  '--use-mock-keychain',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-search-engine-choice-screen',
  '--enable-logging=stderr',
  '--v=0',
  '--window-size=1280,900',
  // A fake microphone (a tone) that is allowed without a prompt, so the voice check can record.
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  // The interface follows the browser's language by default, so checks pin it to English whatever the machine's is.
  '--lang=en-US',
  '--accept-lang=en-US',
  // A display with more than one device pixel per CSS pixel (a Retina display is 2).
  ...(option('--scale') ? [`--force-device-scale-factor=${option('--scale')}`] : []),
  ...(flag('--headful') || legacy ? [] : ['--headless=new']),
  // Headless Chrome announces itself in its user agent, and some real sites then serve a block page.
  ...(flag('--real-ua')
    ? [
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
      ]
    : []),
  'about:blank',
];
const chromePath = option('--chrome') ?? findChrome();
const chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
const consoleLines = [];
const trace = [];
autorunEvents.on('trace', entry => {
  trace.push(entry);
  if (trace.length > 300) trace.shift();
  if (flag('--verbose')) console.log('  [trace]', typeof entry === 'string' ? entry : JSON.stringify(entry));
});
chrome.stderr.setEncoding('utf8');
chrome.stderr.on('data', chunk => {
  for (const line of chunk.split('\n')) {
    const m = /:CONSOLE[^\]]*\] "(.*)", source: (.*)$/.exec(line);
    if (m && m[2].startsWith('chrome-extension://')) {
      consoleLines.push(m[1]);
      if (flag('--verbose')) console.log('  [console]', m[1]);
    }
  }
});
chrome.on('error', error => console.error('Browser launch failed:', error.message));

const progressReports = [];
autorunEvents.on('progress', report => {
  progressReports.push(report);
  const status = !report.ok ? 'FAIL' : report.result?.status === 'partial' ? 'PARTIAL' : 'PASS';
  console.log(`${status} ${report.name} (${report.durationMs} ms)`);
  if (!report.ok) console.log(report.error);
});

const result = await new Promise(resolveResult => {
  const timer = setTimeout(() => resolveResult({ timedOut: true, reports: [...progressReports] }), timeoutMs);
  autorunEvents.once('report', body => {
    clearTimeout(timer);
    resolveResult({ timedOut: false, ...body });
  });
  chrome.once('exit', code => {
    clearTimeout(timer);
    resolveResult({ timedOut: false, exited: code, reports: [] });
  });
  chrome.once('error', error => {
    clearTimeout(timer);
    resolveResult({ timedOut: false, launchError: error.message, reports: [] });
  });
});

const exited = new Promise(r => (chrome.exitCode !== null || !chrome.pid ? r() : chrome.once('exit', r)));
// Windows' Chromium parent process exits before its children. Kill only this test process tree.
if (process.platform === 'win32' && chrome.pid && chrome.exitCode === null) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    chrome.kill();
  }
} else chrome.kill();
await exited;
server.close();
try {
  if (!resolve(profile).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')))
    throw new Error('Refusing to clean a profile outside the temporary directory');
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  // A leftover temporary profile is harmless.
}

const resultsDir = join(root, 'fixtures', '.results');
mkdirSync(resultsDir, { recursive: true });
// A long list of checks is named by its first ones and a count, within the file system's 255-byte limit.
const label =
  names.join('+').length <= 120 ? names.join('+') : `${names.slice(0, 3).join('+')}+${names.length - 3}-more`;
const file = join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.json`);
// Images in reports (data URLs) are written next to the JSON and replaced with their path.
let imageCount = 0;
const extractImages = value => {
  if (typeof value === 'string' && value.startsWith('data:image/png;base64,')) {
    const png = file.replace(/\.json$/, `-${++imageCount}.png`);
    writeFileSync(png, Buffer.from(value.slice('data:image/png;base64,'.length), 'base64'));
    return png;
  }
  if (Array.isArray(value)) return value.map(extractImages);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, extractImages(v)]));
  return value;
};
writeFileSync(
  file,
  JSON.stringify(
    extractImages({
      names,
      args,
      browser: { path: chromePath, legacy, headful: legacy || flag('--headful') },
      ...result,
      trace,
      console: consoleLines,
    }),
    null,
    2,
  ),
);
console.log(`results: ${file}`);
if (result.timedOut) console.log('TIMEOUT: no report from the extension');
const failed = result.timedOut || !result.reports.length || result.reports.some(r => !r.ok);
process.exit(failed ? 1 : 0);
