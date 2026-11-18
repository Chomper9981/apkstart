'use strict';
/**
 * 安装包自带运行时的接管（原在 main.js）。
 * 界面进程和 MCP 服务（Node 模式运行，没有 process.resourcesPath）都要用：
 * 找到 exe 旁边 / resources 下的 runtime，必要时把它登记进设置。
 * @returns {string|null} 本次 exe 自带的运行时目录（不是自带的则为 null）
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

function bootstrapBundledRuntime({ execPath = process.execPath, resourcesPath = process.resourcesPath, log = () => {} } = {}) {
  let bundledRuntimeDir = null;
  try {
    const exeDir = path.dirname(execPath);
    // 便携版把运行时放在 exe 旁边；electron-builder 的 portable 会把资源解到
    // resources/ 下，进程 exe 和 resources 同级，所以几个候选位置都看一下。
    const candidates = [
      path.join(exeDir, 'runtime'),
      path.join(path.dirname(exeDir), 'runtime'),
      path.join(resourcesPath || path.join(exeDir, 'resources'), 'runtime'),
      path.join(resourcesPath || path.join(exeDir, 'resources'), 'app', 'runtime'),
    ];
    // 内置运行时只要求「有 emulator + 任意一套完整系统镜像」，不写死 API 版本：
    // 单文件发行版带的可能是更小的 AOSP 镜像，写死 API34 会让它误判成没有运行时。
    const hasImage = (dir) => {
      const root = path.join(dir, 'system-images');
      let apis = [];
      try { apis = fs.readdirSync(root); } catch (_) { return false; }
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) {
            const d = path.join(root, api, tag, abi);
            // 单文件发行版里的镜像是压缩存放的（system.img.xz / .gz），解压在首次启动时做。
            // 这里只认 system.img 会让「包里明明带了镜像」被判成没带，转而去联网下载。
            const hasSys = ['system.img', 'system.img.xz', 'system.img.gz']
              .some((f) => fs.existsSync(path.join(d, f)));
            if (hasSys && fs.existsSync(path.join(d, 'kernel-ranchu'))) return true;
          }
        }
      }
      return false;
    };
    const bundled = candidates.find((dir) =>
      fs.existsSync(path.join(dir, 'emulator', 'emulator.exe')) && hasImage(dir));
    if (!bundled) return null;

    const s = store.getSettings();
    // 旧版只在 settings.json 不存在时接管：用户先装过在线版再解压完整版，
    // 就会一直走「缺组件」的部署向导。现在只要当前运行时目录里没有 emulator 就接管。
    const explicit = String(s.runtime.dir || '').trim();
    const current = explicit || path.join(store.DATA_DIR, 'runtime');
    // 「另一个安装包的运行时」：路径是 <某目录>/resources/runtime，但不在本次 EXE 的目录树里。
    // 这只可能来自「解压了新版便携包、settings.json 还记着旧包路径」——
    // 实测后果很隐蔽：新包启动，实际跑的是上个版本的 emulator/镜像/快照，
    // 用户升级后仍然卡顿、方向参数还是旧的，甚至旧包一删就彻底起不来。
    // 用户自己挑的目录（D:\ApkStartRuntime 之类）不会被这条规则误伤。
    const looksForeignBundle = /[\\/]resources[\\/]runtime$/i.test(current)
      && !path.resolve(current).toLowerCase().startsWith(path.resolve(exeDir).toLowerCase());
    if (looksForeignBundle && fs.existsSync(path.join(bundled, 'emulator', 'emulator.exe'))) {
      store.saveSettings({ runtime: { dir: bundled } });
      bundledRuntimeDir = bundled;
      try { log(`运行时目录指向别的安装包（${current}），改用随包内置运行时 ${bundled}`); } catch (_) { /* ignore */ }
      return bundledRuntimeDir;
    }
    const currentExe = path.join(current, 'emulator', 'emulator.exe');
    // 便携版被移动/升级（解压到新目录）后，settings 里记的还是旧路径：
    // 必须只认「本次 EXE 所在目录下的 runtime」，否则会一直用旧包里的组件
    // （实测踩过：旧包的 emulator 缺 emulator-check → 加速探测失败 → 退回 TCG 软件模拟）。
    const sameTree = path.resolve(current).toLowerCase()
      .startsWith(path.resolve(exeDir).toLowerCase());
    const currentOk = fs.existsSync(currentExe) && sameTree;
    // 用户自己挑的目录（不在 EXE 目录树里，例如 D:\ApkStartRuntime 或别的盘）
    // 一律尊重：他可能就是为了省 C 盘空间、或让多个便携版共用一个运行时。
    // 旧版在这里无条件覆盖成 exe 旁边的 bundled runtime，表现就是
    // 「设置里改了运行时数据目录，结果还是下到旧目录 / AppData」（issue #23）。
    if (explicit && !sameTree && fs.existsSync(currentExe)) {
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return bundledRuntimeDir;
    }
    // 已有可用运行时（含在线版）就尊重它：AVD 用户数据就在该目录下，不能悄悄搬走
    if (currentOk) {
      // 运行时就在 EXE 目录树里 = 它是安装包自带的（完整版 / 商店版）
      bundledRuntimeDir = current;
      // 但仍把自动参数打开，旧配置里的硬编码 4G/4核/弃用 GPU 模式不能继续用
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return bundledRuntimeDir;
    }
    // 包里带的是 Google Play 镜像才开兼容模式；AOSP 镜像带的是原生 x86_64 库
    let playBundled = false;
    try {
      const root = path.join(bundled, 'system-images');
      for (const api of fs.readdirSync(root)) {
        for (const tag of fs.readdirSync(path.join(root, api))) {
          if (/playstore|google_apis/i.test(tag)) playBundled = true;
        }
      }
    } catch (_) { /* 忽略 */ }
    store.saveSettings({
      runtime: { dir: bundled, compatImage: playBundled },
      engine: { gpuMode: 'auto', autoMemory: true },
    });
    bundledRuntimeDir = bundled;
  } catch (_) { /* 接管失败不阻塞启动，走在线引导 */ }
  return bundledRuntimeDir;
}

module.exports = { bootstrapBundledRuntime };
