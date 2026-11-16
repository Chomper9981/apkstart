'use strict';
/**
 * MCP tools: drive ApkStart's Android runtime (built-in emulator, adb server on port 5044).
 *
 * The tools never touch a physical phone. They reuse the app's own Runtime / AdbClient,
 * so they see exactly the device ApkStart uses — whether ApkStart's window booted it or
 * runtime_start did.
 */
const fs = require('fs');
const path = require('path');
const ui = require('./uitree');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_TEXT = 60000;
const UI_DUMP = '/sdcard/.apkstart_mcp_ui.xml';

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function clip(text, max = MAX_TEXT) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters truncated)` : s;
}

/**
 * @param {object} o
 * @param {string} o.appRoot   ApkStart source root (src/..)
 * @param {(s:string)=>void} [o.log]  diagnostic log (stderr)
 * @param {boolean} [o.allowShell]  register the raw `shell` tool
 * @param {object} [o.runtime]  injected Runtime (tests)
 */
function createTools({ appRoot, log = () => {}, allowShell = false, runtime: injected = null }) {
  let rt = injected;
  let bootedHere = false;
  const runtime = () => {
    if (!rt) {
      const { Runtime } = require('../core/engine');
      rt = new Runtime(appRoot);
    }
    return rt;
  };

  /** Serials currently `device` on ApkStart's adb server. */
  async function onlineSerials() {
    const c = runtime().client();
    try {
      const { stdout } = await c.exec(['devices'], { withSerial: false, timeout: 10000 });
      return String(stdout).split(/\r?\n/).map((l) => l.trim().split(/\s+/))
        .filter((p) => p.length >= 2 && p[1] === 'device').map((p) => p[0]);
    } catch (_) {
      return [];
    }
  }

  /** Why the runtime this server started stopped, if it did (exit code of the emulator process). */
  function lastExit() {
    const em = rt && rt.emulator;
    if (!em || em.lastExitCode === undefined || em.lastExitCode === null) return '';
    const code = em.lastExitCode;
    const hex = code > 0xffff ? ` (0x${(code >>> 0).toString(16).toUpperCase()})` : '';
    const gpu = code === 3221225477 ? ' — the graphics backend of the emulator crashed; runtime_start again will try another GPU backend' : '';
    const ago = em.lastExitAt ? `, ${Math.round((Date.now() - em.lastExitAt) / 1000)}s ago` : '';
    return `The emulator exited with code ${code}${hex}${ago}${gpu}.`;
  }

  /** AdbClient for the online runtime; throws NO_DEVICE (with a hint) if it isn't running. */
  async function device() {
    const r = runtime();
    const preferred = r.client();
    const serials = await onlineSerials();
    if (preferred.serial && serials.includes(preferred.serial)) return preferred;
    const pick = serials.find((s) => /^emulator-\d+$/.test(s)) || serials[0];
    if (pick) return r.client(pick);
    const why = lastExit();
    throw fail('NO_DEVICE', `The Android runtime is not running.${why ? ` ${why}` : ''} Call runtime_start first (or open an app in ApkStart).`);
  }

  async function dumpUi(c) {
    let last = '';
    let timedOut = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      // rm first: a failed dump must not hand back the previous screen
      // eslint-disable-next-line no-await-in-loop
      last = await c.shell(`rm -f ${UI_DUMP}; uiautomator dump ${UI_DUMP} >/dev/null 2>&1; cat ${UI_DUMP} 2>/dev/null`, { timeout: 25000 })
        .catch((e) => { if (e.killed || /ETIMEDOUT|timed? ?out/i.test(String(e.message))) timedOut++; return ''; });
      if (last.includes('<hierarchy')) return ui.parseUiXml(last);
      // eslint-disable-next-line no-await-in-loop
      await sleep(500); // usually "null root node" while an animation is running
    }
    // uiautomator waits for the UI to go idle before dumping; a screen that keeps animating
    // (spinners, pulsing buttons) — especially with software rendering — never does.
    const hint = timedOut
      ? 'uiautomator timed out waiting for the screen to become idle (continuous animation?). Call set_animations with enabled=false and retry, or use screenshot.'
      : `uiautomator returned no hierarchy${last ? `: ${clip(last, 200)}` : ''}. Retry in a moment, or use screenshot.`;
    throw fail('UI_DUMP_FAILED', hint);
  }

  function selectorOf(a) {
    const sel = {};
    for (const k of ['text', 'resource_id', 'description']) if (a[k] !== undefined && a[k] !== '') sel[k] = a[k];
    if (a.exact) sel.exact = true;
    return sel;
  }

  async function resolveTarget(c, a) {
    if (a.x !== undefined || a.y !== undefined) {
      return { x: ui.int(a.x, 'x', 0, 10000), y: ui.int(a.y, 'y', 0, 10000), via: 'coordinates' };
    }
    const sel = selectorOf(a);
    if (!Object.keys(sel).filter((k) => k !== 'exact').length) {
      throw fail('BAD_ARGUMENT', 'give x/y, or one of text / resource_id / description');
    }
    const nodes = await dumpUi(c);
    let hits = ui.findNodes(nodes, sel);
    // Prefer something clickable when several nodes match (a label inside a button, etc.)
    const clickable = hits.filter((n) => n.clickable);
    if (clickable.length) hits = clickable.concat(hits.filter((n) => !n.clickable));
    const index = a.index === undefined ? 0 : ui.int(a.index, 'index', 0, 1000);
    const n = hits[index];
    if (!n) throw fail('NOT_FOUND', `no element matches ${JSON.stringify(sel)}${index ? ` at index ${index}` : ''} (${hits.length} match(es)). Use ui_tree to see the screen.`);
    return { x: n.cx, y: n.cy, via: `[${n.i}] ${n.cls} ${JSON.stringify(n.text || n.desc || n.id)}`, matches: hits.length };
  }

  const selectorProps = {
    text: { type: 'string', description: 'Visible text (case-insensitive substring unless exact=true)' },
    resource_id: { type: 'string', description: 'Resource id, full ("com.app:id/login") or short ("login")' },
    description: { type: 'string', description: 'Content description / accessibility label (substring)' },
    exact: { type: 'boolean', description: 'Match text / description exactly' },
  };
  const pkgProp = { package: { type: 'string', description: 'Android package name, e.g. com.example.app' } };

  const tools = [
    {
      name: 'runtime_status',
      description: 'Is the Android runtime running? Returns the device serial, Android version, screen size and density, and the foreground app.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      handler: async () => {
        const serials = await onlineSerials();
        if (!serials.length) {
          const why = lastExit();
          return { running: false, ...(why ? { last_exit: why } : {}), hint: 'Call runtime_start to boot it (20–90 s; the very first boot also unpacks the system image, a few minutes).' };
        }
        const c = await device();
        const [android, size, density, focus] = await Promise.all([
          c.androidVersion().catch(() => ''),
          c.wmSize().catch(() => null),
          c.shell('wm density').catch(() => ''),
          c.shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | head -n 2").catch(() => ''),
        ]);
        return {
          running: true,
          serial: c.serial,
          android,
          screen: size,
          density: (/(\d+)\s*$/.exec(density) || [])[1] || '',
          foreground: (/([A-Za-z][\w.]+)\/[\w.$]+/.exec(focus) || [])[0] || '',
        };
      },
    },
    {
      name: 'runtime_start',
      description: "Boot ApkStart's built-in Android runtime if it is not running (no phone needed). First boot can take 20–90 s; later boots use a snapshot.",
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        if ((await onlineSerials()).length) {
          const c = await device();
          return `already running (${c.serial})`;
        }
        const lines = [];
        const r = await runtime().ensure({ onLog: (m) => { lines.push(String(m)); log(`runtime: ${m}`); } });
        if (!r || !r.ok) {
          throw fail((r && r.code) || 'BOOT_FAILED', `${(r && r.error) || 'runtime did not start'}\n${lines.slice(-15).join('\n')}`);
        }
        bootedHere = true;
        const c = await device();
        return `runtime ready (${c.serial})`;
      },
    },
    {
      name: 'runtime_stop',
      description: 'Shut down the Android runtime (frees ~1 GB RAM). Installed apps and their data are kept.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { destructiveHint: false },
      handler: async () => {
        await runtime().stop({ graceful: true });
        bootedHere = false;
        return 'runtime stopped';
      },
    },
    {
      name: 'list_apps',
      description: 'List installed packages (third-party only by default).',
      inputSchema: { type: 'object', properties: { include_system: { type: 'boolean' } } },
      annotations: { readOnlyHint: true },
      handler: async (a) => {
        const c = await device();
        const out = await c.shell(`pm list packages ${a.include_system ? '' : '-3'}`.trim(), { timeout: 20000 });
        return out.split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean).sort().join('\n') || '(none)';
      },
    },
    {
      name: 'install_apk',
      description: 'Install (or update) an APK from a local file path on this PC. Returns the package name. Optionally launches it.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string', description: 'Absolute path to the .apk file' }, launch: { type: 'boolean' } },
      },
      handler: async (a) => {
        const p = path.resolve(String(a.path || ''));
        if (!/\.apk$/i.test(p) || !fs.existsSync(p)) throw fail('BAD_ARGUMENT', `not an existing .apk file: ${p}`);
        let meta = null;
        try { meta = require('../core/apk').parseApk(p); } catch (e) { log(`parseApk: ${e.message}`); }
        const c = await device();
        const out = await c.install(p);
        const pkg = meta && meta.package;
        let launched = '';
        if (a.launch && pkg) launched = `\nlaunch: ${await launch(c, pkg, false)}`;
        return `installed${pkg ? ` ${pkg}` : ''}${meta ? ` (${meta.label} ${meta.versionName})` : ''}\n${clip(out, 500)}${launched}`;
      },
    },
    {
      name: 'uninstall_app',
      description: 'Uninstall a package from the runtime.',
      inputSchema: { type: 'object', required: ['package'], properties: { ...pkgProp, keep_data: { type: 'boolean' } } },
      annotations: { destructiveHint: true },
      handler: async (a) => {
        const pkg = ui.assertPackage(a.package);
        const c = await device();
        return clip(await c.shell(`pm uninstall ${a.keep_data ? '-k ' : ''}${pkg}`, { timeout: 30000 }), 500);
      },
    },
    {
      name: 'launch_app',
      description: "Start an installed app via its launcher activity and verify the process is alive. Reports crashes with the logcat reason.",
      inputSchema: { type: 'object', required: ['package'], properties: { ...pkgProp, restart: { type: 'boolean', description: 'Force-stop first (cold start)' } } },
      handler: async (a) => {
        const c = await device();
        return launch(c, ui.assertPackage(a.package), !!a.restart);
      },
    },
    {
      name: 'stop_app',
      description: 'Force-stop an app.',
      inputSchema: { type: 'object', required: ['package'], properties: pkgProp },
      handler: async (a) => {
        const c = await device();
        await c.forceStop(ui.assertPackage(a.package));
        return 'stopped';
      },
    },
    {
      name: 'clear_app_data',
      description: "Wipe an app's data and cache (like a fresh install). Use between test runs.",
      inputSchema: { type: 'object', required: ['package'], properties: pkgProp },
      annotations: { destructiveHint: true },
      handler: async (a) => {
        const c = await device();
        return clip(await c.shell(`pm clear ${ui.assertPackage(a.package)}`, { timeout: 30000 }), 300);
      },
    },
    {
      name: 'screenshot',
      description: 'Capture the Android screen as PNG.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      handler: async () => {
        const c = await device();
        let png;
        try {
          png = await c.screenshot();
        } catch (e) {
          // A failed exec-out carries the (partial, binary) PNG in its message: never echo that back
          const why = lastExit() || (e.code === 'ETIMEDOUT' || e.killed ? 'screencap timed out' : 'screencap failed');
          throw fail('SCREENSHOT_FAILED', why);
        }
        if (!png || png.length < 100 || png.readUInt32BE(0) !== 0x89504e47) throw fail('SCREENSHOT_FAILED', 'screencap returned no PNG');
        return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
      },
    },
    {
      name: 'ui_tree',
      description: 'Dump the current screen as a list of UI elements: index, class, text, description, resource id, flags and tap center @(x,y). Cheaper and more precise than a screenshot for finding things to tap.',
      inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'Include layout-only nodes too' } } },
      annotations: { readOnlyHint: true },
      handler: async (a) => {
        const c = await device();
        const nodes = await dumpUi(c);
        const pkgs = [...new Set(nodes.map((n) => n.pkg).filter(Boolean))];
        return `package: ${pkgs.join(', ') || '?'}\n${ui.formatNodes(nodes, { all: !!a.all })}`;
      },
    },
    {
      name: 'find_elements',
      description: 'Find UI elements by text, resource id or content description.',
      inputSchema: { type: 'object', properties: selectorProps },
      annotations: { readOnlyHint: true },
      handler: async (a) => {
        const c = await device();
        const hits = ui.findNodes(await dumpUi(c), selectorOf(a));
        return hits.length ? ui.formatNodes(hits, { all: true }) : 'no match';
      },
    },
    {
      name: 'tap',
      description: 'Tap at x/y (device pixels), or on the element matching text / resource_id / description (its center). With several matches, clickable ones come first; pick with index.',
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' }, ...selectorProps, index: { type: 'integer', minimum: 0 }, long_press: { type: 'boolean' } },
      },
      handler: async (a) => {
        const c = await device();
        const tgt = await resolveTarget(c, a);
        if (a.long_press) await c.shell(`input swipe ${tgt.x} ${tgt.y} ${tgt.x} ${tgt.y} 800`);
        else await c.shell(`input tap ${tgt.x} ${tgt.y}`);
        return `${a.long_press ? 'long-pressed' : 'tapped'} (${tgt.x},${tgt.y}) via ${tgt.via}${tgt.matches > 1 ? ` — ${tgt.matches} matches, used index ${a.index || 0}` : ''}`;
      },
    },
    {
      name: 'swipe',
      description: 'Swipe from (x1,y1) to (x2,y2) in device pixels.',
      inputSchema: {
        type: 'object',
        required: ['x1', 'y1', 'x2', 'y2'],
        properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, duration_ms: { type: 'integer', minimum: 50, maximum: 5000 } },
      },
      handler: async (a) => {
        const c = await device();
        const v = ['x1', 'y1', 'x2', 'y2'].map((k) => ui.int(a[k], k, 0, 10000));
        const d = a.duration_ms === undefined ? 300 : ui.int(a.duration_ms, 'duration_ms', 50, 5000);
        await c.shell(`input swipe ${v.join(' ')} ${d}`);
        return 'swiped';
      },
    },
    {
      name: 'scroll',
      description: 'Scroll the screen content in a direction (finger moves the opposite way). "down" shows content further down.',
      inputSchema: { type: 'object', required: ['direction'], properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number', description: 'Fraction of the screen, 0.1–0.9 (default 0.6)' } } },
      handler: async (a) => {
        const c = await device();
        const size = (await c.wmSize().catch(() => null)) || { width: 720, height: 1280 };
        const f = Math.min(0.9, Math.max(0.1, Number(a.amount) || 0.6));
        const cx = Math.round(size.width / 2);
        const cy = Math.round(size.height / 2);
        const dy = Math.round((size.height * f) / 2);
        const dx = Math.round((size.width * f) / 2);
        const dir = String(a.direction);
        const [x1, y1, x2, y2] = {
          down: [cx, cy + dy, cx, cy - dy],
          up: [cx, cy - dy, cx, cy + dy],
          right: [cx + dx, cy, cx - dx, cy],
          left: [cx - dx, cy, cx + dx, cy],
        }[dir] || [];
        if (x1 === undefined) throw fail('BAD_ARGUMENT', 'direction must be up / down / left / right');
        await c.shell(`input swipe ${x1} ${y1} ${x2} ${y2} 350`);
        return `scrolled ${dir}`;
      },
    },
    {
      name: 'type_text',
      description: 'Type ASCII text into the focused field (tap the field first). Optionally press Enter afterwards.',
      inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, submit: { type: 'boolean' } } },
      handler: async (a) => {
        const c = await device();
        await c.shell(`input text ${ui.inputTextArg(a.text)}`, { timeout: 20000 });
        if (a.submit) await c.shell('input keyevent 66');
        return `typed ${String(a.text).length} character(s)${a.submit ? ' + Enter' : ''}`;
      },
    },
    {
      name: 'press_key',
      description: `Press a key: ${Object.keys(ui.KEYCODES).join(', ')}, or a numeric Android keycode.`,
      inputSchema: { type: 'object', required: ['key'], properties: { key: { type: ['string', 'integer'] } } },
      handler: async (a) => {
        const c = await device();
        const code = ui.keycodeOf(a.key);
        await c.shell(`input keyevent ${code}`);
        return `pressed ${a.key} (${code})`;
      },
    },
    {
      name: 'wait_for',
      description: 'Wait until an element matching text / resource_id / description appears (or disappears with gone=true). Returns the element or fails on timeout.',
      inputSchema: { type: 'object', properties: { ...selectorProps, gone: { type: 'boolean' }, timeout_ms: { type: 'integer', minimum: 500, maximum: 120000 } } },
      annotations: { readOnlyHint: true },
      handler: async (a) => {
        const sel = selectorOf(a);
        if (!Object.keys(sel).filter((k) => k !== 'exact').length) throw fail('BAD_ARGUMENT', 'give text, resource_id or description');
        const timeout = a.timeout_ms === undefined ? 10000 : ui.int(a.timeout_ms, 'timeout_ms', 500, 120000);
        const c = await device();
        const end = Date.now() + timeout;
        let hits = [];
        do {
          // eslint-disable-next-line no-await-in-loop
          hits = ui.findNodes(await dumpUi(c).catch(() => []), sel);
          if (a.gone ? !hits.length : hits.length) {
            return a.gone ? 'gone' : ui.formatNodes(hits, { all: true, limit: 20 });
          }
          // eslint-disable-next-line no-await-in-loop
          await sleep(600);
        } while (Date.now() < end);
        throw fail('TIMEOUT', `${a.gone ? 'still present' : 'not found'} after ${timeout} ms: ${JSON.stringify(sel)}`);
      },
    },
    {
      name: 'logcat',
      description: 'Read recent Android logs. With package, only that app\'s process (if running). Use clear before an action to see only what it logs.',
      inputSchema: {
        type: 'object',
        properties: {
          ...pkgProp,
          level: { type: 'string', enum: ['V', 'D', 'I', 'W', 'E', 'F'], description: 'Minimum level (default V)' },
          lines: { type: 'integer', minimum: 1, maximum: 5000, description: 'Last N lines (default 300)' },
          grep: { type: 'string', description: 'Only lines containing this text (case-insensitive)' },
          clear: { type: 'boolean', description: 'Clear the log buffer instead of reading it' },
          crashes: { type: 'boolean', description: 'Read the crash buffer (fatal exceptions, native crashes)' },
        },
      },
      annotations: { readOnlyHint: false },
      handler: async (a) => {
        const c = await device();
        if (a.clear) { await c.shell('logcat -c'); return 'log cleared'; }
        const n = a.lines === undefined ? 300 : ui.int(a.lines, 'lines', 1, 5000);
        const args = ['logcat', '-d', '-v', 'threadtime', '-t', String(n)];
        if (a.crashes) args.push('-b', 'crash');
        let note = '';
        if (a.package) {
          const pkg = ui.assertPackage(a.package);
          const pid = String(await c.shell(`pidof ${pkg}`).catch(() => '')).trim().split(/\s+/)[0];
          if (/^\d+$/.test(pid)) args.push(`--pid=${pid}`);
          else note = `(${pkg} is not running: showing all lines mentioning it)\n`;
          if (!/^\d+$/.test(pid)) a.grep = a.grep || pkg;
        }
        // adb joins the arguments into one device-shell command line: quote the filter spec
        args.push(`'*:${ui.logLevel(a.level)}'`);
        const { stdout } = await c.exec(['shell', ...args], { timeout: 30000 });
        let out = String(stdout);
        if (a.grep) {
          const g = String(a.grep).toLowerCase();
          out = out.split(/\r?\n/).filter((l) => l.toLowerCase().includes(g)).join('\n');
        }
        return note + (clip(out.trim()) || '(no log lines)');
      },
    },
    {
      name: 'set_animations',
      description: 'Turn Android system animations off (recommended for automated testing: faster, and ui_tree / wait_for stop timing out on animated screens) or back on. Affects the whole runtime, including what the user sees in ApkStart.',
      inputSchema: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
      handler: async (a) => {
        const c = await device();
        const v = a.enabled ? '1' : '0';
        await c.shell(['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']
          .map((k) => `settings put global ${k} ${v}`).join('; '));
        return `animations ${a.enabled ? 'on' : 'off'}`;
      },
    },
    {
      name: 'current_app',
      description: 'Foreground package / activity.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      handler: async () => {
        const c = await device();
        const out = await c.shell("dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' | head -n 2");
        return (/([A-Za-z][\w.]+\/[\w.$]+)/.exec(out) || [])[1] || clip(out, 300) || 'unknown';
      },
    },
  ];

  if (allowShell) {
    tools.push({
      name: 'shell',
      description: 'Run an arbitrary `adb shell` command on the Android runtime (enabled by APKSTART_MCP_ALLOW_SHELL=1).',
      inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000 } } },
      annotations: { destructiveHint: true },
      handler: async (a) => {
        const c = await device();
        const timeout = a.timeout_ms === undefined ? 30000 : ui.int(a.timeout_ms, 'timeout_ms', 1000, 300000);
        const { stdout, stderr } = await c.exec(['shell', String(a.command || '')], { timeout }).catch((e) => ({ stdout: e.stdout || '', stderr: e.message }));
        return clip(`${stdout || ''}${stderr ? `\n[stderr] ${stderr}` : ''}`.trim() || '(no output)');
      },
    });
  }

  async function launch(c, pkg, restart) {
    try {
      const out = await c.startApp(pkg, '', { freeform: false, forceStop: restart });
      const alive = await c.waitAppAlive(pkg, 4000);
      return alive.ok ? `${pkg} is running` : `${pkg} started but the process is not up yet (${clip(out, 200)})`;
    } catch (e) {
      if (e.crash) e.message += `\n--- crash log ---\n${clip(e.crash, 4000)}`;
      throw e;
    }
  }

  /** Stop the runtime on exit only if this server booted it (don't kill ApkStart's own session). */
  async function shutdown() {
    if (bootedHere && process.env.APKSTART_MCP_KEEP_RUNTIME !== '1') {
      try { await runtime().stop({ graceful: true }); } catch (_) { /* ignore */ }
    }
    try { if (rt && rt._client && rt._client.disposeInput) rt._client.disposeInput(); } catch (_) { /* ignore */ }
  }

  return { tools, shutdown };
}

module.exports = { createTools };
