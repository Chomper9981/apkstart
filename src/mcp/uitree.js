'use strict';
/**
 * Pure helpers for the MCP tools (no adb, unit-testable):
 *   - parse `uiautomator dump` XML into flat nodes with centers
 *   - format nodes compactly for a model
 *   - find nodes by text / resource-id / content-desc
 *   - argument validation and escaping for `adb shell` commands
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

/** @returns {Array<{i:number,text:string,id:string,desc:string,cls:string,pkg:string,clickable:boolean,scrollable:boolean,enabled:boolean,focused:boolean,checked:boolean|null,selected:boolean,password:boolean,bounds:number[],cx:number,cy:number}>} */
function parseUiXml(xml) {
  const nodes = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const a = {};
    for (const am of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[am[1]] = decode(am[2]);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(a.bounds || '');
    const bounds = b ? b.slice(1, 5).map(Number) : [0, 0, 0, 0];
    nodes.push({
      i: nodes.length,
      text: a.text || '',
      id: a['resource-id'] || '',
      desc: a['content-desc'] || '',
      cls: (a.class || '').replace(/^android\.widget\./, '').replace(/^android\.view\./, ''),
      pkg: a.package || '',
      clickable: a.clickable === 'true' || a['long-clickable'] === 'true',
      scrollable: a.scrollable === 'true',
      enabled: a.enabled !== 'false',
      focused: a.focused === 'true',
      checked: a.checkable === 'true' ? a.checked === 'true' : null,
      selected: a.selected === 'true',
      password: a.password === 'true',
      bounds,
      cx: Math.round((bounds[0] + bounds[2]) / 2),
      cy: Math.round((bounds[1] + bounds[3]) / 2),
    });
  }
  return nodes;
}

/** Nodes worth showing to a model: anything with text / id / description, or interactive. */
function interesting(n) {
  const area = (n.bounds[2] - n.bounds[0]) * (n.bounds[3] - n.bounds[1]);
  if (area <= 0) return false;
  return !!(n.text || n.desc || n.clickable || n.scrollable || n.checked !== null || (n.id && !/:id\/(content|statusBarBackground|navigationBarBackground)$/.test(n.id)));
}

function formatNodes(nodes, { all = false, limit = 400 } = {}) {
  const list = all ? nodes : nodes.filter(interesting);
  const lines = list.slice(0, limit).map((n) => {
    const parts = [`[${n.i}] ${n.cls || 'View'}`];
    if (n.text) parts.push(JSON.stringify(n.password ? '••••' : n.text.slice(0, 120)));
    if (n.desc) parts.push(`desc=${JSON.stringify(n.desc.slice(0, 120))}`);
    if (n.id) parts.push(`id=${n.id.replace(/^[\w.]+:id\//, '')}`);
    const flags = [];
    if (n.clickable) flags.push('clickable');
    if (n.scrollable) flags.push('scrollable');
    if (n.checked !== null) flags.push(n.checked ? 'checked' : 'unchecked');
    if (n.selected) flags.push('selected');
    if (n.focused) flags.push('focused');
    if (!n.enabled) flags.push('disabled');
    if (flags.length) parts.push(`{${flags.join(',')}}`);
    parts.push(`@(${n.cx},${n.cy})`);
    return parts.join(' ');
  });
  if (list.length > limit) lines.push(`… ${list.length - limit} more nodes (narrow with find_elements)`);
  return lines.join('\n');
}

/**
 * Find nodes. Text / desc match case-insensitively as a substring unless exact=true;
 * resource_id matches the full id or its part after ":id/".
 */
function findNodes(nodes, { text, resource_id: rid, description, exact = false, clickable } = {}) {
  const norm = (s) => String(s || '').toLowerCase();
  const match = (val, want) => (exact ? String(val) === String(want) : norm(val).includes(norm(want)));
  return nodes.filter((n) => {
    if (text !== undefined && text !== '' && !match(n.text, text)) return false;
    if (description !== undefined && description !== '' && !match(n.desc, description)) return false;
    if (rid !== undefined && rid !== '') {
      const short = n.id.replace(/^[\w.]+:id\//, '');
      if (n.id !== rid && short !== rid) return false;
    }
    if (clickable !== undefined && n.clickable !== clickable) return false;
    const area = (n.bounds[2] - n.bounds[0]) * (n.bounds[3] - n.bounds[1]);
    return area > 0;
  });
}

const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
function assertPackage(pkg) {
  if (!PKG_RE.test(String(pkg || ''))) {
    const e = new Error(`invalid package name: ${JSON.stringify(pkg)}`);
    e.code = 'BAD_ARGUMENT';
    throw e;
  }
  return pkg;
}

function int(v, name, min = -100000, max = 100000) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    const e = new Error(`${name} must be a number in [${min}, ${max}], got ${JSON.stringify(v)}`);
    e.code = 'BAD_ARGUMENT';
    throw e;
  }
  return Math.round(n);
}

/**
 * Argument for `input text` run through the device shell.
 * `input text` cannot type spaces literally (%s means space) and only handles ASCII reliably.
 */
function inputTextArg(text) {
  const s = String(text == null ? '' : text);
  if (!s) { const e = new Error('text is empty'); e.code = 'BAD_ARGUMENT'; throw e; }
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(s)) {
    const e = new Error('type_text only supports printable ASCII (adb `input text` limitation); use paste-free alternatives or set the field another way');
    e.code = 'UNSUPPORTED_TEXT';
    throw e;
  }
  // `input text` turns "%s" into a space and has no escape for a literal "%s".
  const spaced = s.replace(/ /g, '%s');
  return `'${spaced.replace(/'/g, "'\\''")}'`;
}

const KEYCODES = {
  back: 4, home: 3, enter: 66, delete: 67, backspace: 67, forward_delete: 112, tab: 61, escape: 111,
  menu: 82, app_switch: 187, recents: 187, search: 84, space: 62,
  dpad_up: 19, dpad_down: 20, dpad_left: 21, dpad_right: 22, dpad_center: 23,
  volume_up: 24, volume_down: 25, volume_mute: 164, power: 26, wakeup: 224, sleep: 223,
  page_up: 92, page_down: 93, move_home: 122, move_end: 123, media_play_pause: 85,
};
function keycodeOf(key) {
  if (typeof key === 'number' || /^\d+$/.test(String(key))) return int(key, 'key', 0, 400);
  const k = String(key || '').toLowerCase().replace(/^keycode_/, '');
  if (!Object.prototype.hasOwnProperty.call(KEYCODES, k)) {
    const e = new Error(`unknown key ${JSON.stringify(key)}; use one of ${Object.keys(KEYCODES).join(', ')} or a numeric keycode`);
    e.code = 'BAD_ARGUMENT';
    throw e;
  }
  return KEYCODES[k];
}

const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
function logLevel(l) {
  const v = String(l || 'V').toUpperCase()[0];
  return LEVELS.includes(v) ? v : 'V';
}

module.exports = { parseUiXml, formatNodes, findNodes, interesting, assertPackage, int, inputTextArg, keycodeOf, KEYCODES, logLevel, decode };
