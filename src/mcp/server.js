'use strict';
/**
 * ApkStart MCP server — lets an AI agent install, run, inspect and drive Android apps in
 * ApkStart's built-in runtime. No phone, no Android SDK.
 *
 * Start it (stdio):
 *   - installed app : "ApkStart.exe" --mcp
 *   - from source   : node src/mcp/server.js        (or: npm run mcp)
 *
 * Environment:
 *   APKSTART_MCP_ALLOW_SHELL=1    also expose a raw `shell` tool
 *   APKSTART_MCP_KEEP_RUNTIME=1   leave a runtime this server booted running when it exits
 *
 * stdout carries the protocol only: every console.* call is redirected to stderr
 * before any app module is loaded.
 */
const path = require('path');

function redirectConsole() {
  const toErr = (...a) => process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
  console.log = toErr;
  console.info = toErr;
  console.warn = toErr;
  console.debug = toErr;
}

const INSTRUCTIONS = [
  "Controls ApkStart's built-in Android runtime (an emulator on this PC; no phone needed).",
  'Typical loop: runtime_status → runtime_start (if needed) → install_apk / launch_app →',
  'ui_tree (find elements and their tap centers) → tap / type_text / swipe / press_key →',
  'wait_for to sync on the next screen → screenshot to look, logcat for errors.',
  'For automated test runs call set_animations(enabled=false) first: animated screens make ui_tree time out.',
  'Prefer ui_tree + tap(text=…) over guessing coordinates from screenshots.',
  'Coordinates are device pixels (see runtime_status screen size).',
].join(' ');

function run({ appRoot = path.join(__dirname, '..', '..'), input = process.stdin, output = process.stdout, exit = (c) => process.exit(c) } = {}) {
  redirectConsole();
  const i18n = require('../i18n');
  const store = require('../core/store');
  // Settle the UI language exactly like main.js does, before anything writes settings.json:
  // otherwise, on a fresh install where the agent runs first, the ApkStart window would later
  // see an existing settings file and treat the user as an upgrader (→ Chinese UI).
  try {
    const r = i18n.resolveInitialLanguage({ saved: store.getSettings().language, existingUser: store.existingUser, systemLocales: i18n.systemLocales() });
    if (r.source !== 'saved') store.saveSettings({ language: r.lang });
  } catch (_) { /* never block the server on this */ }
  // Installed app run as `ApkStart.exe server.js` with ELECTRON_RUN_AS_NODE=1: register the
  // runtime that ships with the installer (same as the window does at startup).
  if (process.versions.electron) {
    try { require('../core/bundled').bootstrapBundledRuntime(); } catch (_) { /* ignore */ }
  }
  // Tool output is for the agent: keep it in English whatever the UI language is.
  // (Only this process; the ApkStart window keeps its own setting.)
  i18n.setLang('en');

  const { McpServer } = require('./protocol');
  const { createTools } = require('./tools');
  const pkg = require(path.join(appRoot, 'package.json'));
  const log = (m) => process.stderr.write(`[apkstart-mcp] ${m}\n`);
  const { tools, shutdown } = createTools({
    appRoot,
    log,
    allowShell: process.env.APKSTART_MCP_ALLOW_SHELL === '1',
  });

  const server = new McpServer({
    info: { name: 'apkstart', title: 'ApkStart Android runtime', version: pkg.version },
    instructions: INSTRUCTIONS,
    tools,
    input,
    output,
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await shutdown();
    exit(0);
  };
  server.onClose(close);
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  server.start();
  log(`ready (${tools.length} tools)`);
  return server;
}

module.exports = { run };

if (require.main === module) run();
