'use strict';
/**
 * MCP server tests — no device, no adb: a fake AdbClient records the commands.
 * Run: node test/mcp-test.js (part of npm test)
 */
const { PassThrough } = require('stream');
const path = require('path');
const { spawn } = require('child_process');
const ui = require('../src/mcp/uitree');
const { McpServer } = require('../src/mcp/protocol');
const { createTools } = require('../src/mcp/tools');

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.demo" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][720,1280]">
<node index="0" text="Welcome &amp; hello" resource-id="com.demo:id/title" class="android.widget.TextView" package="com.demo" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,100][680,160]" />
<node index="1" text="" resource-id="com.demo:id/user" class="android.widget.EditText" package="com.demo" content-desc="Username" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[40,300][680,380]" />
<node index="2" text="secret" resource-id="com.demo:id/pass" class="android.widget.EditText" package="com.demo" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="true" selected="false" bounds="[40,400][680,480]" />
<node index="3" text="" resource-id="com.demo:id/login" class="android.widget.Button" package="com.demo" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,600][680,700]">
<node index="0" text="Log in" resource-id="" class="android.widget.TextView" package="com.demo" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[300,630][420,670]" />
</node>
<node index="4" text="Remember me" resource-id="com.demo:id/remember" class="android.widget.CheckBox" package="com.demo" content-desc="" checkable="true" checked="true" clickable="true" enabled="false" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,720][400,780]" />
<node index="5" text="ghost" resource-id="" class="android.widget.TextView" package="com.demo" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][0,0]" />
</node></hierarchy>`;

console.log('\n[mcp] ui tree');

test('parseUiXml: attributes, entities, bounds and centers', () => {
  const n = ui.parseUiXml(XML);
  eq(n.length, 8);
  eq(n[1].text, 'Welcome & hello');
  eq(n[1].cls, 'TextView');
  eq(n[4].id, 'com.demo:id/login');
  eq(n[4].cx, 360); eq(n[4].cy, 650);
  eq(n[6].checked, true); eq(n[6].enabled, false);
  eq(n[3].password, true);
});

test('formatNodes: hides passwords, skips layout-only and zero-size nodes, shows flags', () => {
  const out = ui.formatNodes(ui.parseUiXml(XML));
  assert(!out.includes('secret'), 'password text must not be shown');
  assert(out.includes('••••'));
  assert(!out.includes('FrameLayout'), 'layout-only root hidden by default');
  assert(!out.includes('ghost'), 'zero-size node hidden');
  assert(/CheckBox "Remember me" id=remember \{clickable,checked,disabled\} @\(220,750\)/.test(out), out);
  assert(ui.formatNodes(ui.parseUiXml(XML), { all: true }).includes('FrameLayout'));
});

test('findNodes: text substring / exact, short and full resource id, description', () => {
  const n = ui.parseUiXml(XML);
  eq(ui.findNodes(n, { text: 'log' }).length, 1);
  eq(ui.findNodes(n, { text: 'log', exact: true }).length, 0);
  eq(ui.findNodes(n, { resource_id: 'login' })[0].i, 4);
  eq(ui.findNodes(n, { resource_id: 'com.demo:id/login' })[0].i, 4);
  eq(ui.findNodes(n, { description: 'user' })[0].id, 'com.demo:id/user');
  eq(ui.findNodes(n, { text: 'ghost' }).length, 0, 'zero-size nodes are not tappable');
});

console.log('\n[mcp] argument safety');

test('package names are validated before reaching the device shell', () => {
  ui.assertPackage('com.example.app');
  for (const bad of ['', 'com', 'com.x; rm -rf /', 'com.x && reboot', '$(id).x', 'com.x`id`']) {
    let threw = false;
    try { ui.assertPackage(bad); } catch (e) { threw = e.code === 'BAD_ARGUMENT'; }
    assert(threw, `must reject ${JSON.stringify(bad)}`);
  }
});

test('inputTextArg: single-quoted for the device shell, spaces as %s, non-ASCII refused', () => {
  eq(ui.inputTextArg('hello world'), "'hello%sworld'");
  eq(ui.inputTextArg("it's; reboot"), "'it'\\''s;%sreboot'");
  eq(ui.inputTextArg('$(id)`x`'), "'$(id)`x`'");
  let code = '';
  try { ui.inputTextArg('xin chào'); } catch (e) { code = e.code; }
  eq(code, 'UNSUPPORTED_TEXT');
});

test('keycodeOf: names, numbers, unknown rejected', () => {
  eq(ui.keycodeOf('back'), 4); eq(ui.keycodeOf('KEYCODE_ENTER'), 66); eq(ui.keycodeOf(26), 26);
  let threw = false;
  try { ui.keycodeOf('rm -rf'); } catch (_) { threw = true; }
  assert(threw);
});

console.log('\n[mcp] protocol');

/** Drive an McpServer in-process through streams. */
function harness(tools) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new McpServer({ info: { name: 't', version: '0' }, tools, input, output });
  server.start();
  let buf = '';
  const waiting = new Map();
  output.setEncoding('utf8');
  output.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const i = ++id;
    waiting.set(i, resolve);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`);
  });
  return { call, input };
}

test('initialize / tools/list / tools/call / errors', async () => {
  const h = harness([
    { name: 'echo', description: 'e', inputSchema: { type: 'object' }, handler: async (a) => `hi ${a.x}` },
    { name: 'boom', description: 'b', inputSchema: { type: 'object' }, handler: async () => { const e = new Error('nope'); e.code = 'X'; throw e; } },
  ]);
  const init = await h.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
  eq(init.result.protocolVersion, '2025-03-26');
  assert(init.result.capabilities.tools);
  const unknownVer = await h.call('initialize', { protocolVersion: '1999-01-01' });
  eq(unknownVer.result.protocolVersion, '2025-06-18', 'falls back to the latest supported version');
  h.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  eq((await h.call('tools/list')).result.tools.map((t) => t.name).join(','), 'echo,boom');
  eq((await h.call('tools/call', { name: 'echo', arguments: { x: 1 } })).result.content[0].text, 'hi 1');
  const err = await h.call('tools/call', { name: 'boom', arguments: {} });
  eq(err.result.isError, true, 'tool errors are results, not protocol errors');
  assert(err.result.content[0].text.includes('[X]') && err.result.content[0].text.includes('nope'));
  eq((await h.call('tools/call', { name: 'nope' })).error.code, -32602);
  eq((await h.call('no/such')).error.code, -32601);
  eq(JSON.stringify((await h.call('ping')).result), '{}');
});

console.log('\n[mcp] tools (fake device)');

/** A fake Runtime + AdbClient: records shell commands, answers from a script. */
function fakeRuntime({ online = true, screens = [XML] } = {}) {
  const cmds = [];
  let screen = 0;
  const client = {
    serial: 'emulator-5554',
    async exec(args) {
      cmds.push(args.join(' '));
      if (args[0] === 'devices') return { stdout: `List of devices attached\n${online ? 'emulator-5554\tdevice\n' : ''}` };
      if (args[0] === 'shell' && args[1] === 'logcat') return { stdout: '11-17 10:00:00.000 1 2 E App: boom com.demo\n11-17 10:00:01.000 1 2 I Other: fine\n' };
      return { stdout: '' };
    },
    async shell(cmd) {
      cmds.push(`shell ${cmd}`);
      if (cmd.includes('uiautomator dump')) {
        const x = screens[Math.min(screen, screens.length - 1)];
        screen++;
        return x;
      }
      if (cmd.startsWith('pidof')) return '4242';
      if (cmd === 'wm size') return 'Physical size: 720x1280';
      return '';
    },
    async wmSize() { return { width: 720, height: 1280 }; },
    async forceStop(p) { cmds.push(`forceStop ${p}`); },
    async screenshot() { return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200)]); },
    async androidVersion() { return '14'; },
  };
  return { cmds, runtime: { client: () => client, ensure: async () => ({ ok: true }), stop: async () => true } };
}

function toolMap(rt, opts = {}) {
  const { tools } = createTools({ appRoot: path.join(__dirname, '..'), runtime: rt.runtime, ...opts });
  return Object.fromEntries(tools.map((t) => [t.name, t.handler]));
}

test('tap by text taps the center of the matching element', async () => {
  const rt = fakeRuntime();
  const out = await toolMap(rt).tap({ text: 'Log in' });
  // "Log in" is a non-clickable label inside the Button; its center lies inside the button.
  assert(rt.cmds.includes('shell input tap 360 650'), rt.cmds.join(' | '));
  assert(out.includes('tapped (360,650)'));
});

test('tap by resource id / coordinates, long press', async () => {
  const rt = fakeRuntime();
  const t = toolMap(rt);
  await t.tap({ resource_id: 'user' });
  await t.tap({ x: 10, y: 20 });
  await t.tap({ resource_id: 'login', long_press: true });
  assert(rt.cmds.includes('shell input tap 360 340'));
  assert(rt.cmds.includes('shell input tap 10 20'));
  assert(rt.cmds.includes('shell input swipe 360 650 360 650 800'));
});

test('tap with no match fails with NOT_FOUND (no blind tap)', async () => {
  const rt = fakeRuntime();
  let code = '';
  try { await toolMap(rt).tap({ text: 'Nope' }); } catch (e) { code = e.code; }
  eq(code, 'NOT_FOUND');
  assert(!rt.cmds.some((c) => c.includes('input tap')));
});

test('wait_for polls until the element appears', async () => {
  const empty = '<hierarchy rotation="0"><node text="" class="x" bounds="[0,0][720,1280]" /></hierarchy>';
  const rt = fakeRuntime({ screens: [empty, empty, XML] });
  const out = await toolMap(rt).wait_for({ text: 'Remember', timeout_ms: 5000 });
  assert(out.includes('Remember me'));
});

test('type_text and press_key send escaped shell commands', async () => {
  const rt = fakeRuntime();
  const t = toolMap(rt);
  await t.type_text({ text: 'a b', submit: true });
  await t.press_key({ key: 'back' });
  assert(rt.cmds.includes("shell input text 'a%sb'"));
  assert(rt.cmds.includes('shell input keyevent 66'));
  assert(rt.cmds.includes('shell input keyevent 4'));
});

test('logcat for a running package filters by pid and quotes the filter spec', async () => {
  const rt = fakeRuntime();
  const out = await toolMap(rt).logcat({ package: 'com.demo', level: 'E', lines: 50 });
  assert(rt.cmds.some((c) => c === "shell logcat -d -v threadtime -t 50 --pid=4242 '*:E'"), rt.cmds.join(' | '));
  assert(out.includes('boom'));
});

test('screenshot returns an MCP image', async () => {
  const r = await toolMap(fakeRuntime()).screenshot({});
  eq(r.content[0].type, 'image'); eq(r.content[0].mimeType, 'image/png');
});

test('no runtime → NO_DEVICE with a hint; runtime_status says not running', async () => {
  const rt = fakeRuntime({ online: false });
  const t = toolMap(rt);
  let err = null;
  try { await t.tap({ x: 1, y: 1 }); } catch (e) { err = e; }
  eq(err && err.code, 'NO_DEVICE');
  assert(/runtime_start/.test(err.message));
  eq((await t.runtime_status({})).running, false);
});

test('shell tool only exists when explicitly allowed', () => {
  assert(!('shell' in toolMap(fakeRuntime())));
  assert('shell' in toolMap(fakeRuntime(), { allowShell: true }));
});

console.log('\n[mcp] stdio process');

test('node src/mcp/server.js: handshake over real stdio, nothing but JSON on stdout', async () => {
  // Own APPDATA: the server settles the UI language and may write settings.json
  const appData = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'apkstart-mcp-test-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp', 'server.js')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, APPDATA: appData } });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const end = Date.now() + 15000;
  while (Date.now() < end && out.split('\n').filter(Boolean).length < 2) await new Promise((r) => setTimeout(r, 100));
  child.stdin.end();
  await new Promise((r) => { child.on('exit', r); setTimeout(r, 5000); });
  const lines = out.split('\n').filter(Boolean);
  eq(lines.length, 2, `stdout must contain exactly the 2 responses, got:\n${out.slice(0, 500)}`);
  const list = JSON.parse(lines[1]);
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['runtime_start', 'install_apk', 'launch_app', 'ui_tree', 'tap', 'screenshot', 'logcat']) assert(names.includes(n), `missing tool ${n}`);
  assert(!names.includes('shell'), 'shell tool off by default');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
  }
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
