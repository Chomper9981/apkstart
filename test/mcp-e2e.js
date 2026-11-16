'use strict';
/**
 * End-to-end check of the MCP server against a REAL Android runtime (talks stdio like an agent).
 *
 *   node test/mcp-e2e.js <app.apk> [--exe <ApkStart.exe>] [--data <dir>] [--keep]
 *
 *   --exe   run the server through an installed / unpacked ApkStart.exe (ELECTRON_RUN_AS_NODE=1),
 *           using the runtime bundled with it. Default: node + the runtime in your ApkStart settings.
 *   --data  APPDATA to use (default: a fresh temp dir — first boot unpacks the system image, ~4 GB)
 *   --keep  leave the runtime running at the end
 *   --stress N  afterwards loop N rounds of screenshot + ui_tree + scroll (the load that crashed -gpu host)
 *
 * Output: test/out/mcp-e2e/ (screenshots, ui tree, logcat).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const apk = argv.find((a, i) => !a.startsWith('--') && !['--exe', '--data', '--stress'].includes(argv[i - 1]));
if (!apk || !fs.existsSync(apk)) { console.error('usage: node test/mcp-e2e.js <app.apk> [--exe ApkStart.exe] [--data dir] [--keep]'); process.exit(2); }
const exe = opt('--exe');
const dataDir = opt('--data') || fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-mcp-e2e-'));
const OUT = path.join(__dirname, 'out', 'mcp-e2e');
fs.mkdirSync(OUT, { recursive: true });

const server = path.join(__dirname, '..', 'src', 'mcp', 'server.js');
const env = { ...process.env, APPDATA: dataDir, ...(argv.includes('--keep') ? { APKSTART_MCP_KEEP_RUNTIME: '1' } : {}) };
const child = exe
  ? spawn(exe, [server], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn(process.execPath, [server], { env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write(String(d).split('\n').filter((l) => l.trim()).map((l) => `    · ${l}\n`).join('')));

let buf = '';
let nonJson = 0;
const waiting = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { nonJson++; continue; }
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); w(msg); }
  }
});
let seq = 0;
function rpc(method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const textOf = (r) => (r.result && r.result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

let passed = 0;
let failed = 0;
async function step(name, tool, args = {}, { timeout = 60000, check = () => true, save } = {}) {
  const t0 = Date.now();
  let r;
  try { r = await rpc('tools/call', { name: tool, arguments: args }, timeout); } catch (e) { r = { error: { message: e.message } }; }
  const ms = Date.now() - t0;
  const text = r.error ? `protocol error: ${r.error.message}` : textOf(r);
  let ok = !r.error && !(r.result && r.result.isError);
  if (ok) { try { ok = check(r, text) !== false; } catch (e) { ok = false; } }
  if (save) save(r, text);
  console.log(`${ok ? '✓' : '✗'} ${name} (${(ms / 1000).toFixed(1)}s)`);
  const shown = text.split('\n').slice(0, 6).join('\n      ');
  if (shown) console.log(`      ${shown}`);
  if (ok) passed++; else failed++;
  return { r, text, ok };
}

(async () => {
  console.log(`APPDATA=${dataDir}\nserver via ${exe || 'node'}\n`);
  // generous: the first launch of a freshly built exe can be held up by an antivirus scan
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }, 180000);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  console.log(`server ${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}`);
  const list = await rpc('tools/list');
  console.log(`${list.result.tools.length} tools\n`);

  await step('runtime_status (before)', 'runtime_status');
  const boot = await step('runtime_start', 'runtime_start', {}, { timeout: 15 * 60000 });
  if (!boot.ok) throw new Error('runtime did not start');
  await step('runtime_status', 'runtime_status', {}, { check: (r, t) => /"running": true/.test(t) });
  const inst = await step('install_apk + launch', 'install_apk', { path: path.resolve(apk), launch: true }, { timeout: 5 * 60000, check: (r, t) => /installed/.test(t) });
  const pkg = (/installed ([\w.]+)/.exec(inst.text) || [])[1];
  await step('list_apps contains it', 'list_apps', {}, { check: (r, t) => pkg && t.includes(pkg) });
  await new Promise((r) => setTimeout(r, 4000));
  await step('current_app', 'current_app', {}, { check: (r, t) => !pkg || t.includes(pkg) });
  await step('screenshot', 'screenshot', {}, {
    check: (r) => r.result.content[0].type === 'image',
    save: (r) => { const c = r.result && r.result.content && r.result.content[0]; if (c && c.data) fs.writeFileSync(path.join(OUT, 'app.png'), Buffer.from(c.data, 'base64')); },
  });
  const tree = await step('ui_tree', 'ui_tree', {}, { timeout: 90000, check: (r, t) => /@\(\d+,\d+\)/.test(t), save: (r, t) => fs.writeFileSync(path.join(OUT, 'ui_tree.txt'), t) });
  // Tap the first clickable element the tree reports, by its text if it has one
  const first = (tree.text.split('\n').find((l) => /clickable/.test(l) && /"[^"]+"/.test(l)) || '');
  const label = (/"([^"]+)"/.exec(first) || [])[1];
  if (label) await step(`tap text=${JSON.stringify(label)}`, 'tap', { text: label }, { timeout: 90000 });
  else await step('tap center', 'tap', { x: 360, y: 640 });
  await step('wait_for any text (2s)', 'wait_for', { text: label || 'a', timeout_ms: 2000 }, { check: () => true });
  await step('scroll down', 'scroll', { direction: 'down' });
  await step('press_key back', 'press_key', { key: 'back' });
  await step('logcat (app, warnings+)', 'logcat', { package: pkg, level: 'W', lines: 200 }, { save: (r, t) => fs.writeFileSync(path.join(OUT, 'logcat.txt'), t) });
  await step('logcat crashes', 'logcat', { crashes: true, lines: 50 });
  await step('stop_app', 'stop_app', { package: pkg });
  await step('home + screenshot', 'press_key', { key: 'home' });
  await step('screenshot (home)', 'screenshot', {}, {
    save: (r) => { const c = r.result && r.result.content && r.result.content[0]; if (c && c.data) fs.writeFileSync(path.join(OUT, 'home.png'), Buffer.from(c.data, 'base64')); },
  });
  // --stress N: the load that used to crash the emulator (screen capture + UI dumps + input in a loop)
  const rounds = Number(opt('--stress') || 0);
  if (rounds > 0) {
    await step('set_animations off', 'set_animations', { enabled: false });
    await step('relaunch for stress', 'launch_app', { package: pkg }, { timeout: 120000 });
    const t0 = Date.now();
    let ok = 0;
    for (let i = 1; i <= rounds; i++) {
      const a = await rpc('tools/call', { name: 'screenshot', arguments: {} }, 60000).catch((e) => ({ error: e }));
      const b = await rpc('tools/call', { name: 'ui_tree', arguments: {} }, 90000).catch((e) => ({ error: e }));
      const c = await rpc('tools/call', { name: 'scroll', arguments: { direction: i % 2 ? 'down' : 'up' } }, 60000).catch((e) => ({ error: e }));
      const bad = [a, b, c].find((r) => r.error || (r.result && r.result.isError));
      if (bad) {
        console.log(`✗ stress round ${i}/${rounds} failed after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${(bad.error && bad.error.message) || textOf(bad).slice(0, 300)}`);
        failed++;
        break;
      }
      ok++;
      if (i % 10 === 0) console.log(`  · stress ${i}/${rounds} ok (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
    if (ok === rounds) { passed++; console.log(`✓ stress ${rounds} rounds (${((Date.now() - t0) / 1000).toFixed(0)}s)`); }
  }
  if (!argv.includes('--keep')) await step('runtime_stop', 'runtime_stop', {}, { timeout: 120000 });
})().catch((e) => { failed++; console.error(`✗ ${e.message}`); }).finally(() => {
  if (nonJson) { failed++; console.log(`✗ stdout carried ${nonJson} non-JSON line(s)`); }
  child.stdin.end();
  setTimeout(() => {
    try { child.kill(); } catch (_) { /* gone */ }
    console.log(`\n结果：${passed} 通过，${failed} 失败  (artifacts: ${path.relative(path.join(__dirname, '..'), OUT)})`);
    process.exit(failed ? 1 : 0);
  }, 3000);
});
