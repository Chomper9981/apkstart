'use strict';
// 断言里比对的是中文原文：固定界面语言，不随本机系统语言变化
require('../src/i18n').setLang('zh');
/**
 * 空闲回收 / 退出关机 / 开机自启不预热 的纯 Node 测试（不需要 Electron、不需要模拟器）。
 *
 * 背景（真实故障）：ApkStart 随 Windows 自启后会预热一台 3GB 的安卓虚拟机；
 * 空闲回收的判据是「安卓里没有前台 Activity」，只要有一个应用界面停在前台就永远不回收
 * （实测一次预热后常驻了 12 小时）；而退出 ApkStart 又不关虚拟机，看门狗也跟着没了 ——
 * 用户看到的就是「用久了占一大块内存，关掉也不还，只能重启电脑」。
 *
 * 运行：node test/idle-shutdown-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 独立数据目录：Runtime 会读 settings.json，不能碰用户真实的那份
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-idle-test-'));

const container = require('../src/core/container');
const { Runtime } = require('../src/core/engine');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const MIN = 60000;

/** 造一个不碰真实模拟器 / adb 的 Runtime：只保留空闲判定用到的那几样 */
function fakeRuntime({ idleMinutes = 15, running = true, online = true } = {}) {
  const rt = new Runtime(path.join(__dirname, '..'));
  Object.defineProperty(rt, 'settings', { get: () => ({ engine: { idleShutdownMinutes: idleMinutes } }) });
  Object.defineProperty(rt, 'vmRunning', { get: () => running });
  rt.calls = { stop: 0, isOnline: 0, runningPackages: 0 };
  rt.client = () => ({
    isOnline: async () => { rt.calls.isOnline++; return online; },
    // 旧判据会调这个：安卓里一直有个应用停在前台
    runningPackages: async () => { rt.calls.runningPackages++; return ['com.example.game']; },
  });
  rt.stop = async () => { rt.calls.stop++; return true; };
  rt.log = () => {};
  return rt;
}

(async () => {
  console.log('\n[空闲判定 idleDecision]');

  test('没设空闲时间（0）= 不回收', () => {
    assert.equal(container.idleDecision({ limitMs: 0, lastActivity: 0, now: 99 * MIN }), 'disabled');
  });
  test('有应用窗口开着 = 不回收，哪怕很久没操作', () => {
    assert.equal(container.idleDecision({ limitMs: 15 * MIN, activeApps: 1, lastActivity: 0, now: 600 * MIN }), 'active');
  });
  test('窗口还显示着 = 不回收', () => {
    assert.equal(container.idleDecision({ limitMs: 15 * MIN, visible: true, lastActivity: 0, now: 600 * MIN }), 'visible');
  });
  test('刚操作过 = 不回收', () => {
    assert.equal(container.idleDecision({ limitMs: 15 * MIN, lastActivity: 10 * MIN, now: 20 * MIN }), 'recent');
  });
  test('没有窗口 + 超时 = 回收', () => {
    assert.equal(container.idleDecision({ limitMs: 15 * MIN, lastActivity: 0, now: 15 * MIN }), 'stop');
  });

  console.log('\n[Runtime._idleCheck]');

  await atest('安卓里有应用停在前台也照样回收（旧判据会永远不回收）', async () => {
    const rt = fakeRuntime();
    rt.lastActivity = Date.now() - 16 * MIN;
    const v = await rt._idleCheck();
    assert.equal(v, 'stopped');
    assert.equal(rt.calls.stop, 1, '应该关掉虚拟机');
    assert.equal(rt.calls.runningPackages, 0, '不该再用「前台 Activity」当判据');
  });

  await atest('有应用窗口开着时不回收', async () => {
    const rt = fakeRuntime();
    rt._activeApps.add('com.example.game');
    rt.lastActivity = Date.now() - 600 * MIN;
    assert.equal(await rt._idleCheck(), 'active');
    assert.equal(rt.calls.stop, 0);
  });

  await atest('应用窗口还显示着：不回收，并且重新计时', async () => {
    const rt = fakeRuntime();
    rt.hasVisibleSession = () => true;
    rt.lastActivity = Date.now() - 600 * MIN;
    assert.equal(await rt._idleCheck(), 'visible');
    assert.equal(rt.calls.stop, 0);
    assert(Date.now() - rt.lastActivity < 5000, '可见期间要刷新最近活动时间');
  });

  await atest('正在安装应用时不打断', async () => {
    const rt = fakeRuntime();
    rt.installing = true;
    rt.lastActivity = Date.now() - 600 * MIN;
    assert.equal(await rt._idleCheck(), 'busy');
    assert.equal(rt.calls.stop, 0);
  });

  await atest('接管来的虚拟机（没有进程句柄）只要 adb 在线也要回收', async () => {
    const rt = fakeRuntime({ running: false, online: true });
    rt.lastActivity = Date.now() - 16 * MIN;
    assert.equal(await rt._idleCheck(), 'stopped');
    assert.equal(rt.calls.stop, 1);
  });

  await atest('虚拟机根本没在跑：什么都不做', async () => {
    const rt = fakeRuntime({ running: false, online: false });
    rt.lastActivity = Date.now() - 16 * MIN;
    assert.equal(await rt._idleCheck(), 'offline');
    assert.equal(rt.calls.stop, 0);
  });

  await atest('空闲时间设为 0 = 用户明确要常驻', async () => {
    const rt = fakeRuntime({ idleMinutes: 0 });
    rt.lastActivity = 0;
    assert.equal(await rt._idleCheck(), 'disabled');
    assert.equal(rt.calls.stop, 0);
  });

  await atest('关掉最后一个应用窗口后从这一刻起算空闲', async () => {
    const rt = fakeRuntime();
    rt.client = () => ({ forceStop: async () => {}, shell: async () => '', isOnline: async () => true });
    rt.emulator.setPriority = async () => {};
    rt._armSnapshotSave = () => {};
    rt._activeApps.add('com.example.game');
    rt.lastActivity = Date.now() - 600 * MIN;
    await rt.endApp('com.example.game');
    assert(Date.now() - rt.lastActivity < 5000, 'endApp 要刷新最近活动时间');
    assert.equal(await rt._idleCheck(), 'recent', '刚关窗口不能立刻回收（马上重开要秒进）');
  });

  console.log('\n[退出与开机自启：源码约束]');

  const root = path.join(__dirname, '..');
  const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');

  test('退出时默认关掉虚拟机，且只在运行时归自己管时才关', () => {
    assert(/keepRuntimeOnExit: false/.test(storeJs), '默认不保留');
    const fn = mainJs.slice(mainJs.indexOf('const stopRuntimeOnExit'), mainJs.indexOf('const releaseRuntime'));
    assert(/keepRuntimeOnExit === true\) return/.test(fn), '用户打开「退出后保留」时不关');
    assert(/if \(!ownsRuntime\(\)\) return/.test(fn), '另一个实例接管后不能关它的虚拟机');
    assert(/quitKeepRuntime\) return/.test(fn), '更新 / 重启自身的退出要跳过');
    assert(/runtime\.stop\(\)/.test(fn), '要走会存快照的 stop()，不能强杀');
    assert(/await stopRuntimeOnExit\(\);/.test(mainJs), 'before-quit 收尾里要等它做完');
  });

  test('更新和重启自身的退出不关虚拟机', () => {
    const hits = (mainJs.match(/quitting = true; quitKeepRuntime = true; app\.quit\(\)/g) || []).length;
    assert.equal(hits, 3, `更新 / 续传更新 / 重启 三处都要标记，实际 ${hits} 处`);
  });

  test('随 Windows 开机自启时不预热，推迟到第一次打开窗口', () => {
    assert(/if \(args\.silent\) \{\s*\n\s*deferredPrewarm = runPrewarm;/.test(mainJs), '自启时只登记，不执行');
    assert(/if \(deferredPrewarm\) \{ const run = deferredPrewarm; deferredPrewarm = null; run\(\); \}/.test(mainJs),
      'showWindow 时补做一次');
  });

  test('退出收尾期间再次启动：收尾完成后把自己拉起来，而不是去用正在关机的虚拟机', () => {
    assert(/if \(quitting\) \{ pendingRelaunchArgs = /.test(mainJs), 'second-instance 要先看是不是在退出');
    assert(/app\.relaunch\(\{ args: pendingRelaunchArgs \}\)/.test(mainJs), '收尾完成后重新拉起');
  });

  test('托盘菜单可以手动关闭安卓环境', () => {
    assert(/label: (t\()?'关闭安卓环境（释放内存）'/.test(mainJs));
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
