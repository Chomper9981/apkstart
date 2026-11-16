'use strict';
/**
 * Emulator stability probe (diagnostics, not part of npm test).
 *
 *   node test/emu-probe.js --runtime <runtime dir> --avd-home <dir> --gpu host|swangle|... [--rounds 60]
 *                          [--boot-timeout 900] [--extra "-feature -Vulkan"]
 *
 * Boots the AVD "apkstart" directly (same env / main args as ApkStart), reports how long each
 * boot stage takes (adb device → boot_completed → launcher), then runs `rounds` of the load that
 * crashed it in practice (screencap + uiautomator dump + input swipe) and reports hangs / exits.
 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const runtime = path.resolve(opt('--runtime', 'build/runtime'));
const avdHome = path.resolve(opt('--avd-home', ''));
const gpu = opt('--gpu', 'host');
const rounds = Number(opt('--rounds', 60));
const bootTimeout = Number(opt('--boot-timeout', 900)) * 1000;
const extra = (opt('--extra', '') || '').split(/\s+/).filter(Boolean);
const port = Number(opt('--port', 5570));
const serial = `emulator-${port}`;
const adb = path.join(runtime, 'platform-tools', 'adb.exe');
const emu = path.join(runtime, 'emulator', 'emulator.exe');
const env = {
  ...process.env,
  ANDROID_SDK_ROOT: runtime, ANDROID_HOME: runtime, ANDROID_AVD_HOME: avdHome, ANDROID_EMULATOR_HOME: avdHome,
  ANDROID_ADB_SERVER_PORT: '5044', ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
};
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (m) => console.log(`${ts()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(args, timeout = 30000, binary = false) {
  return new Promise((resolve) => {
    execFile(adb, ['-s', serial, ...args], { env, timeout, windowsHide: true, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 << 20 }, (err, out) => {
      resolve({ ok: !err, out: binary ? out : String(out || '').trim(), err: err && (err.killed ? 'timeout' : err.message.split('\n')[0]) });
    });
  });
}

const args = ['-avd', 'apkstart', '-port', String(port), '-no-boot-anim', '-no-metrics', '-crash-report-mode', 'disabled',
  '-gpu', gpu, '-memory', opt('--memory', '3072'), '-cores', opt('--cores', '4'), '-skin', '720x1280',
  '-no-snapshot', ...extra];
log(`spawn: emulator ${args.join(' ')}`);
const proc = spawn(emu, args, { env, windowsHide: true });
let exited = null;
const interesting = /hanging thread|FATAL|Failed to create Vulkan|Selecting Vulkan device|crash|abort|exception|lost|timeout/i;
const tail = [];
const onLine = (l) => {
  l = l.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!l) return;
  tail.push(l); if (tail.length > 40) tail.shift();
  if (interesting.test(l)) log(`  emu| ${l.slice(0, 200)}`);
};
for (const s of [proc.stdout, proc.stderr]) {
  let b = '';
  s.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { onLine(b.slice(0, i)); b = b.slice(i + 1); } });
}
proc.on('exit', (code) => {
  exited = code;
  log(`EMULATOR EXITED code=${code}${code === 3221225477 ? ' (0xC0000005)' : ''}`);
});

(async () => {
  // ---- boot stages ----
  const stages = {};
  const mark = (k) => { if (!stages[k]) { stages[k] = Date.now() - t0; log(`stage ${k}`); } };
  while (exited === null && Date.now() - t0 < bootTimeout) {
    const st = await sh(['get-state'], 8000);
    if (st.ok && st.out === 'device') {
      mark('adb-device');
      const p = await sh(['shell', 'getprop sys.boot_completed; getprop init.svc.bootanim; getprop dev.bootcomplete'], 10000);
      const [bc] = p.out.split(/\r?\n/);
      if (bc === '1') mark('boot_completed');
      if (stages.boot_completed) {
        const f = await sh(['shell', "dumpsys window | grep mCurrentFocus"], 15000);
        if (/launcher|Launcher|nexuslauncher/i.test(f.out)) { mark('launcher'); break; }
      }
    }
    await sleep(3000);
  }
  if (exited !== null || !stages.boot_completed) {
    log(`BOOT FAILED (stages: ${JSON.stringify(stages)})`);
    console.log(tail.slice(-15).join('\n'));
    finish(1);
    return;
  }
  log(`BOOT OK ${JSON.stringify(Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, `${(v / 1000).toFixed(0)}s`])))}`);

  // ---- load ----
  const loadStart = Date.now();
  let slowest = 0;
  for (let i = 1; i <= rounds && exited === null; i++) {
    const r0 = Date.now();
    const a = await sh(['exec-out', 'screencap', '-p'], 30000, true);
    const b = await sh(['shell', 'uiautomator dump /sdcard/p.xml >/dev/null 2>&1; wc -c /sdcard/p.xml'], 40000);
    const c = await sh(['shell', `input swipe 360 ${i % 2 ? 900 : 400} 360 ${i % 2 ? 400 : 900} 250`], 15000);
    const dt = Date.now() - r0;
    slowest = Math.max(slowest, dt);
    const fail = [a, b, c].find((x) => !x.ok);
    if (fail) { log(`round ${i}: adb failed (${fail.err})`); break; }
    if (i % 10 === 0 || dt > 8000) log(`round ${i}/${rounds} ok (${dt} ms, png ${a.out.length} B)`);
  }
  const survived = exited === null;
  log(`LOAD ${survived ? 'SURVIVED' : 'CRASHED'} after ${((Date.now() - loadStart) / 1000).toFixed(0)}s, slowest round ${slowest} ms`);
  if (!survived) console.log(tail.slice(-15).join('\n'));
  finish(survived ? 0 : 1);
})();

function finish(code) {
  if (exited === null) {
    execFile(adb, ['-s', serial, 'emu', 'kill'], { env }, () => {});
    setTimeout(() => { try { proc.kill(); } catch (_) { /* gone */ } process.exit(code); }, 8000);
  } else process.exit(code);
}
