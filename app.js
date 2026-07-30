/* Shop Inventory: local-first audit app. No build step, no backend.
   User marks live in IndexedDB keyed by stable item id, so the seed catalog
   can be regenerated later without losing any of the audit. */

'use strict';

var CYCLE = ['unknown', 'have', 'missing', 'upgrade', 'blocking', 'na'];
var GLYPH = { unknown: '\u00b7', have: 'H', missing: 'M', upgrade: 'U', blocking: '!', na: '\u00d7' };
var SLABEL = {
  unknown: 'Not audited', have: 'Have', missing: 'Missing',
  upgrade: 'Upgrade', blocking: 'Blocking', na: 'N/A'
};
var GAPS = { missing: 1, upgrade: 1, blocking: 1 };
var DB_NAME = 'shop-inventory';
var STORE = 'kv';
var KEY = 'user-v1';

var seed = null;
var index = {};        /* id -> { item, sec, sub } */
var flat = [];         /* ordered list of index entries */
var user = {};         /* id -> { s, q, sp, n, c, u } */
var prefs = { theme: 'dark', wake: false, group: 'priority' };
var ui = { filter: 'all', query: '', collapsed: {}, open: null };
var lastChange = null;
var toastTimer = null;
var wakeSentinel = null;

/* ---------------- checklist parser ----------------
   The deployment ships the canonical markdown checklist and parses it here,
   so there is one source of truth and no build step. Item ids are derived from
   content, which keeps saved marks attached when the checklist is edited. */

var STORE_RULES = [
  ['Welding supply', ['weld', 'tungsten', 'argon', 'cylinder', 'contact tip', 'electrode',
    'mig', 'tig', 'flux core', 'spool gun', 'flowmeter', 'anti-spatter', 'filler']],
  ['Hobby shop', ['rc ', 'shock', 'turnbuckle', 'lexan', 'pinion', 'spur', 'lipo', 'servo',
    'body clip', 'nitro', 'glow plug', 'body reamer', 'droop', 'camber', 'pit mat',
    'hex driver', 'nut driver', 'filament', 'nozzle', 'build plate', 'ptfe',
    'gridfinity', 'printer', 'hotend']],
  ['Electronics', ['solder', 'multimeter', 'oscilloscope', 'flux', 'resistor', 'capacitor',
    'breadboard', 'esd', 'heat shrink', 'crimper', 'connector', 'xt60', 'jst', 'dupont',
    'logic analyzer', 'bench power supply', 'hot air', 'desolder', 'probe', 'microscope',
    'wire, ', 'awg', 'transistor', 'mosfet', 'diode', 'led ', 'header pin', 'programmer', 'usb']],
  ['Auto parts', ['brake', 'oil', 'coolant', 'obd', 'spark plug', 'lug', 'tire', 'caliper',
    'fuel', 'battery', 'fuse', 'relay', 'grease', 'jack', 'torque', 'filter', 'trim',
    'gasket', 'penetrating', 'anti-seize', 'thread locker', 'rtv', 'wheel', 'axle',
    'compression', 'leak down', 'timing']],
  ['Harbor Freight', ['vise', 'clamp', 'grinder', 'press', 'hammer', 'punch', 'chisel',
    'pry', 'sledge', 'anvil', 'cart', 'bench', 'shop vac', 'creeper', 'stand', 'hoist',
    'compressor', 'abrasive', 'cutoff wheel', 'flap disc', 'sandpaper', 'drill', 'tap',
    'die', 'socket', 'wrench', 'plier', 'screwdriver', 'file', 'saw', 'extension', 'ratchet']]
];

function slugify(text) {
  var s = String(text).toLowerCase().replace(/"/g, 'in').replace(/'/g, '');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s.slice(0, 48) || 'item';
}

function classifyStore(label, sectionTitle) {
  var hay = (label + ' ' + sectionTitle).toLowerCase();
  for (var i = 0; i < STORE_RULES.length; i++) {
    var keys = STORE_RULES[i][1];
    for (var j = 0; j < keys.length; j++) {
      if (hay.indexOf(keys[j]) >= 0) return STORE_RULES[i][0];
    }
  }
  return 'General';
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function parseChecklist(text) {
  var lines = text.split(/\r?\n/);
  var sections = [];
  var sec = null, sub = null;
  var used = {};

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+$/, '');
    var m;

    if ((m = /^##\s+(\d+)\.\s+(.*)$/.exec(line))) {
      sec = { id: 's' + pad2(parseInt(m[1], 10)), num: parseInt(m[1], 10),
        title: m[2].split(' (')[0].trim(), subsections: [] };
      sections.push(sec);
      sub = null;
      continue;
    }

    if ((m = /^###\s+(\d+)\.(\d+)\s+(.*)$/.exec(line)) && sec) {
      sub = { id: sec.id + '-' + pad2(parseInt(m[2], 10)), num: m[1] + '.' + m[2],
        title: m[3].split(' (')[0].trim(), items: [] };
      sec.subsections.push(sub);
      continue;
    }

    if ((m = /^-\s+\[\s*\]\s+(.*)$/.exec(line)) && sec) {
      if (!sub) {
        sub = { id: sec.id + '-00', num: sec.num + '.0', title: 'General', items: [] };
        sec.subsections.push(sub);
      }

      var t = m[1].replace(/\*\*/g, '').trim();
      var qty = false, target = null, phase = null;

      if (/,?\s*count:\s*_+/.test(t)) {
        qty = true;
        t = t.replace(/,?\s*count:\s*_+/g, '').trim();
      }

      var wm = /\(want\s+(?:a\s+)?(\d+|dozen)\+?[^)]*\)/i.exec(t);
      if (wm) {
        target = wm[1].toLowerCase() === 'dozen' ? 12 : parseInt(wm[1], 10);
        qty = true;
      }

      var pm = /\(Phase\s+(\d)/i.exec(t);
      if (pm) phase = parseInt(pm[1], 10);

      var spec = /_{2,}/.test(t);
      t = t.replace(/_{2,}/g, '___').replace(/\s{2,}/g, ' ').trim();
      t = t.replace(/,$/, '').trim();

      var tags = [];
      if (sec.num === 1) tags.push('safety');
      var st = sub.title.toLowerCase();
      if ((st.indexOf('fire') >= 0 || st.indexOf('medical') >= 0 ||
           st.indexOf('safety') >= 0 || st.indexOf('battery') >= 0 ||
           st.indexOf('charging') >= 0) && tags.indexOf('safety') < 0) {
        tags.push('safety');
      }
      if (qty) tags.push('consumable');
      if (phase !== null && phase >= 3) tags.push('later');

      var base = sub.id + '-' + slugify(t);
      var id = base, n = 2;
      while (used[id]) { id = base + '-' + n; n++; }
      used[id] = 1;

      sub.items.push({ id: id, label: t, qty: qty, target: target, spec: spec,
        phase: phase, tags: tags, store: classifyStore(t, sec.title) });
    }
  }

  var out = [];
  for (var k = 0; k < sections.length; k++) {
    var s2 = sections[k];
    var subs = [];
    for (var q = 0; q < s2.subsections.length; q++) {
      if (s2.subsections[q].items.length) subs.push(s2.subsections[q]);
    }
    if (!subs.length) continue;
    s2.subsections = subs;
    s2.count = 0;
    for (var r = 0; r < subs.length; r++) s2.count += subs[r].items.length;
    out.push(s2);
  }

  var total = 0;
  for (var z = 0; z < out.length; z++) total += out[z].count;
  return { version: 1, generated: '2026-07-29', totalItems: total, sections: out };
}

/* ---------------- storage ---------------- */

function openDb() {
  return new Promise(function (resolve, reject) {
    if (!window.indexedDB) { reject(new Error('no idb')); return; }
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function idbGet(key) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readonly');
      var r = tx.objectStore(STORE).get(key);
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  });
}

function idbSet(key, val) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

var saveTimer = null;
function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    var payload = { user: user, prefs: prefs, savedAt: new Date().toISOString() };
    idbSet(KEY, payload)['catch'](function () {
      try { localStorage.setItem(KEY, JSON.stringify(payload)); } catch (e) { /* full */ }
    });
  }, 180);
}

function loadSaved() {
  return idbGet(KEY)['catch'](function () {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  });
}

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rec(id) { return user[id] || null; }
function statusOf(id) { var r = user[id]; return (r && r.s) || 'unknown'; }
function qtyOf(id) { var r = user[id]; return r && typeof r.q === 'number' ? r.q : null; }
function costOf(id) { var r = user[id]; return r && typeof r.c === 'number' ? r.c : null; }

function touch(id) {
  if (!user[id]) user[id] = {};
  user[id].u = new Date().toISOString();
  return user[id];
}

function setStatus(id, s, remember) {
  var prev = statusOf(id);
  if (prev === s) return prev;
  if (remember !== false) lastChange = { id: id, prev: prev };
  var r = touch(id);
  if (s === 'unknown') { delete r.s; } else { r.s = s; }
  if (!r.s && !r.q && !r.sp && !r.n && typeof r.c !== 'number') delete user[id];
  persist();
  return prev;
}

function isRestock(entry) {
  var it = entry.item;
  if (!it.qty || !it.target) return false;
  if (statusOf(it.id) === 'na') return false;
  var q = qtyOf(it.id);
  /* Only a counted item can be short. An unaudited consumable is unknown,
     not missing, so it stays off the buy list until you actually count it. */
  if (q === null) return false;
  return q < it.target;
}

function stats() {
  var s = { total: flat.length, have: 0, gap: 0, na: 0, unknown: 0, blocking: 0, safety: 0, restock: 0, cost: 0 };
  for (var i = 0; i < flat.length; i++) {
    var e = flat[i], st = statusOf(e.item.id);
    if (st === 'have') s.have++;
    else if (st === 'na') s.na++;
    else if (GAPS[st]) {
      s.gap++;
      if (st === 'blocking') s.blocking++;
      if (e.item.tags.indexOf('safety') >= 0) s.safety++;
    } else s.unknown++;
    var restock = isRestock(e);
    if (restock) s.restock++;
    if (GAPS[st] || restock) {
      var c = costOf(e.item.id);
      if (c) s.cost += c;
    }
  }
  s.audited = s.have + s.gap + s.na;
  return s;
}

function sectionStats(sec) {
  var o = { total: 0, have: 0, gap: 0, na: 0, unknown: 0 };
  for (var i = 0; i < sec.subsections.length; i++) {
    var items = sec.subsections[i].items;
    for (var j = 0; j < items.length; j++) {
      o.total++;
      var st = statusOf(items[j].id);
      if (st === 'have') o.have++;
      else if (st === 'na') o.na++;
      else if (GAPS[st]) o.gap++;
      else o.unknown++;
    }
  }
  return o;
}

function gaugeInner(o) {
  var t = o.total || 1;
  var pc = function (n) { return (n / t * 100).toFixed(2) + '%'; };
  return '<span class="gauge-have" style="width:' + pc(o.have) + '"></span>' +
    '<span class="gauge-gap" style="width:' + pc(o.gap) + '"></span>' +
    '<span class="gauge-na" style="width:' + pc(o.na) + '"></span>';
}

function gaugeHtml(o) {
  return '<div class="gauge">' + gaugeInner(o) + '</div>';
}

function money(n) {
  if (!n) return '$0';
  return '$' + Math.round(n).toLocaleString('en-US');
}

/* ---------------- chrome ---------------- */

function paintPlate() {
  var s = stats();
  document.getElementById('tallyDone').textContent = s.audited;
  document.getElementById('tallyTotal').textContent = s.total;
  document.getElementById('plateGauge').innerHTML = gaugeInner(s);
  var badge = document.getElementById('buyBadge');
  var n = s.gap + s.restock;
  badge.textContent = n > 999 ? '999+' : String(n);
  badge.hidden = n === 0;
}

function setNav(name) {
  var links = document.querySelectorAll('#dock .dock-btn');
  for (var i = 0; i < links.length; i++) {
    var el = links[i];
    if (el.getAttribute('data-nav') === name) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
}

function toast(msg, undoable) {
  var t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  document.getElementById('toastUndo').hidden = !undoable;
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.hidden = true; }, 5200);
}

/* ---------------- views ---------------- */

function viewIndex() {
  var s = stats();
  var h = '';

  h += '<div class="wrap"><div class="eyebrow">Triage</div></div>';
  h += '<div class="placards">';
  h += placard('danger', s.blocking, 'Blocking gaps', 'Missing and stopping a job', '#/buy');
  h += placard('warning', s.safety, 'Safety gaps', 'PPE, fire, medical, lifting', '#/buy');
  h += placard('caution', s.restock, 'Restock', 'Consumables below target', '#/buy');
  h += '</div>';

  h += '<div class="btn-row">';
  var next = firstUnaudited();
  if (next) {
    h += '<a class="btn btn-primary btn-block" href="#/s/' + next.sec.id + '">Resume audit at ' +
      esc(next.sec.num + '. ' + next.sec.title) + '</a>';
  } else {
    h += '<span class="btn btn-block">Audit complete. ' + s.gap + ' gaps found.</span>';
  }
  h += '</div>';

  h += '<div class="wrap"><div class="eyebrow">Search all ' + s.total + ' items</div>' +
    '<input class="search" id="globalSearch" type="search" inputmode="search" ' +
    'placeholder="19 mm, flap disc, tourniquet\u2026" value="' + esc(ui.query) + '"></div>';
  h += '<div id="globalResults"></div>';

  h += '<div class="wrap"><div class="eyebrow">Sections</div></div>';
  h += '<div class="sec-list" id="secList">';
  for (var i = 0; i < seed.sections.length; i++) {
    var sec = seed.sections[i], o = sectionStats(sec);
    h += '<a class="sec-row" href="#/s/' + sec.id + '">' +
      '<span class="sec-num">' + (sec.num < 10 ? '0' : '') + sec.num + '</span>' +
      '<span class="sec-main"><span class="sec-title">' + esc(sec.title) + '</span>' +
      '<span class="sec-meta">' + o.have + ' have \u00b7 ' + o.gap + ' gap \u00b7 ' +
      o.unknown + ' left</span></span>' +
      '<span class="sec-gauge">' + gaugeHtml(o) + '</span></a>';
  }
  h += '</div>';

  h += '<div class="wrap"><div class="eyebrow">Status marks</div></div>';
  h += '<div class="legend">' +
    legend('have', 'Have', 'Owned, condition fine') +
    legend('upgrade', 'Upgrade', 'Own it, but it is junk') +
    legend('missing', 'Missing', 'Do not have it') +
    legend('blocking', 'Blocking', 'Missing and stopping work') +
    legend('na', 'N/A', 'Out of scope for good') +
    legend('unknown', 'Not audited', 'Default state') +
    '</div>';

  h += '<div class="wrap"><p class="sub" style="margin-top:16px">Tap the left block to cycle a mark. ' +
    'Tap the item name for quantity, spec, notes, and cost.</p></div>';

  document.getElementById('view').innerHTML = h;
  if (ui.query) renderGlobalResults();
  setNav('index');
}

function placard(kind, count, title, desc, href) {
  return '<a class="placard placard-' + kind + '" href="' + href + '">' +
    '<span class="placard-count">' + count + '</span>' +
    '<span class="placard-body"><span class="placard-title">' + esc(title) + '</span>' +
    '<span class="placard-desc">' + esc(desc) + '</span></span>' +
    '<span class="placard-arrow">\u203a</span></a>';
}

function legend(s, name, desc) {
  return '<div class="legend-cell"><span class="legend-glyph" style="color:' + legendColor(s) + '">' +
    GLYPH[s] + '</span><span class="legend-text"><b>' + esc(name) + '</b>' + esc(desc) + '</span></div>';
}

function legendColor(s) {
  return { have: 'var(--safety)', upgrade: 'var(--caution)', missing: 'var(--warning)',
    blocking: 'var(--danger)', na: 'var(--steel-500)', unknown: 'var(--steel-400)' }[s];
}

function firstUnaudited() {
  for (var i = 0; i < flat.length; i++) {
    if (statusOf(flat[i].item.id) === 'unknown') return flat[i];
  }
  return null;
}

function renderGlobalResults() {
  var box = document.getElementById('globalResults');
  if (!box) return;
  var q = ui.query.trim().toLowerCase();
  if (!q) { box.innerHTML = ''; return; }
  var hits = [];
  for (var i = 0; i < flat.length && hits.length < 60; i++) {
    if (flat[i].item.label.toLowerCase().indexOf(q) >= 0) hits.push(flat[i]);
  }
  if (!hits.length) {
    box.innerHTML = '<div class="empty"><strong>No match for &ldquo;' + esc(ui.query) + '&rdquo;</strong>' +
      'Try a shorter term, like a size or a material.</div>';
    return;
  }
  var h = '<div class="group-head"><span class="group-name">' + hits.length +
    ' match' + (hits.length === 1 ? '' : 'es') + '</span></div>';
  for (var j = 0; j < hits.length; j++) h += itemHtml(hits[j], true);
  box.innerHTML = h;
}

function viewSection(secId) {
  var sec = null;
  for (var i = 0; i < seed.sections.length; i++) {
    if (seed.sections[i].id === secId || seed.sections[i].id === 's' + secId) sec = seed.sections[i];
  }
  if (!sec) { location.hash = '#/'; return; }

  var o = sectionStats(sec);
  var h = '';
  h += '<div class="toolbar">' +
    '<div class="toolbar-top">' +
    '<a class="back" href="#/" aria-label="Back to index">\u2039</a>' +
    '<span class="toolbar-title"><span class="t">' + esc(sec.title) + '</span>' +
    '<span class="m">Section ' + sec.num + ' \u00b7 ' + o.have + '/' + o.total + ' have \u00b7 ' +
    o.unknown + ' left</span></span></div>' +
    '<input class="search" id="secSearch" type="search" inputmode="search" placeholder="Filter this section\u2026" value="' + esc(ui.query) + '">' +
    '<div class="chips">' +
    chip('all', 'All') + chip('unaudited', 'Not audited') + chip('gaps', 'Gaps') +
    chip('have', 'Have') + chip('safety', 'Safety') + chip('consumable', 'Consumables') +
    chip('early', 'Phase 0-1') +
    '</div></div>';
  h += '<div id="list"></div>';

  document.getElementById('view').innerHTML = h;
  renderList(sec);
  setNav('index');
  window.scrollTo(0, 0);
}

function chip(f, label) {
  return '<button type="button" class="chip" data-act="chip" data-filter="' + f +
    '" aria-pressed="' + (ui.filter === f) + '">' + esc(label) + '</button>';
}

function passesFilter(entry) {
  var it = entry.item, st = statusOf(it.id);
  switch (ui.filter) {
    case 'unaudited': return st === 'unknown';
    case 'gaps': return !!GAPS[st] || isRestock(entry);
    case 'have': return st === 'have';
    case 'safety': return it.tags.indexOf('safety') >= 0;
    case 'consumable': return it.qty === true;
    case 'early': return it.phase === null || it.phase === 0 || it.phase === 1;
    default: return true;
  }
}

function renderList(sec) {
  var q = ui.query.trim().toLowerCase();
  var h = '';
  var shown = 0;

  for (var i = 0; i < sec.subsections.length; i++) {
    var sub = sec.subsections[i];
    var visible = [];
    for (var j = 0; j < sub.items.length; j++) {
      var entry = index[sub.items[j].id];
      if (q && entry.item.label.toLowerCase().indexOf(q) < 0) continue;
      if (!passesFilter(entry)) continue;
      visible.push(entry);
    }
    if (!visible.length) continue;
    shown += visible.length;

    var collapsed = !!ui.collapsed[sub.id];
    var so = { total: 0, have: 0, gap: 0, na: 0 };
    for (var k = 0; k < sub.items.length; k++) {
      so.total++;
      var st = statusOf(sub.items[k].id);
      if (st === 'have') so.have++; else if (st === 'na') so.na++; else if (GAPS[st]) so.gap++;
    }

    h += '<section class="subsec">';
    h += '<button type="button" class="subsec-head" data-act="collapse" data-sub="' + sub.id + '">' +
      '<span class="subsec-num">' + esc(sub.num) + '</span>' +
      '<span class="subsec-title">' + esc(sub.title) + '</span>' +
      '<span class="subsec-count">' + so.have + '/' + so.total + '</span>' +
      '<span class="subsec-caret">' + (collapsed ? '\u25b8' : '\u25be') + '</span></button>';

    if (!collapsed) {
      if (so.have + so.gap + so.na < so.total) {
        h += '<button type="button" class="bulk" data-act="bulk" data-sub="' + sub.id + '">' +
          '+ Mark remaining ' + (so.total - so.have - so.gap - so.na) + ' in ' + esc(sub.num) + ' as Have</button>';
      }
      for (var m = 0; m < visible.length; m++) h += itemHtml(visible[m], false);
    }
    h += '</section>';
  }

  if (!shown) {
    h = '<div class="empty"><strong>Nothing matches</strong>Clear the filter or the search to see the rest of this section.</div>';
  }
  document.getElementById('list').innerHTML = h;
}

function itemHtml(entry, showSection) {
  var it = entry.item;
  var st = statusOf(it.id);
  var r = rec(it.id);
  var q = qtyOf(it.id);
  var open = ui.open === it.id;

  var flags = '';
  var safetyImplied = entry.sec.num === 1 && !showSection;
  if (it.tags.indexOf('safety') >= 0 && !safetyImplied) {
    flags += '<span class="flag flag-safety">SAF</span>';
  }
  if (it.phase !== null && it.phase >= 2) flags += '<span class="flag flag-phase">P' + it.phase + '</span>';
  if (r && r.n) flags += '<span class="flag flag-note">NOTE</span>';
  if (it.target) flags += '<span class="flag flag-qty">\u2265' + it.target + '</span>';

  var qtyBit = '';
  if (it.qty) {
    var low = it.target && (q === null ? 0 : q) < it.target;
    qtyBit = '<span class="qty-inline' + (low ? ' qty-low' : '') + '">' + (q === null ? '\u2013' : q) + '</span>';
  }

  var secBit = showSection
    ? '<span class="item-sec">' + esc(entry.sec.num + '. ' + entry.sec.title +
        ' \u00b7 ' + entry.sub.title) + '</span>'
    : '';

  var h = '<div class="item" data-status="' + st + '" data-item="' + it.id + '">' +
    '<div class="item-row">' +
    '<button type="button" class="status" data-act="cycle" data-id="' + it.id + '" data-s="' + st +
    '" aria-label="' + esc(it.label + ': ' + SLABEL[st] + '. Tap to change.') + '">' + GLYPH[st] + '</button>' +
    '<button type="button" class="item-body" data-act="expand" data-id="' + it.id + '">' +
    '<span class="item-label">' + esc(it.label) + secBit + '</span>' +
    qtyBit +
    '<span class="item-flags">' + flags + '</span>' +
    '</button></div>';

  if (open) h += expanderHtml(entry);
  h += '</div>';
  return h;
}

function expanderHtml(entry) {
  var it = entry.item;
  var st = statusOf(it.id);
  var r = rec(it.id) || {};
  var q = qtyOf(it.id);

  var h = '<div class="exp">';
  h += '<div class="exp-label">Mark</div><div class="set-row">';
  var opts = ['have', 'missing', 'upgrade', 'blocking', 'na'];
  for (var i = 0; i < opts.length; i++) {
    h += '<button type="button" class="set-btn" data-act="set" data-id="' + it.id + '" data-s="' + opts[i] +
      '" data-sv="' + opts[i] + '" aria-pressed="' + (st === opts[i]) + '">' + esc(SLABEL[opts[i]]) + '</button>';
  }
  h += '</div>';

  if (it.qty) {
    h += '<div class="exp-label">Quantity on hand</div><div class="field stepper">' +
      '<button type="button" class="step-btn" data-act="qty" data-id="' + it.id + '" data-d="-1" aria-label="Decrease">\u2212</button>' +
      '<span class="step-val" data-qtyval="' + it.id + '">' + (q === null ? 0 : q) + '</span>' +
      '<button type="button" class="step-btn" data-act="qty" data-id="' + it.id + '" data-d="1" aria-label="Increase">+</button>' +
      (it.target ? '<span class="step-target">target ' + it.target + '</span>' : '') +
      '</div>';
  }

  if (it.spec) {
    h += '<div class="exp-label">Spec</div><div class="field">' +
      '<input class="field-in" type="text" data-fld="sp" data-id="' + it.id +
      '" placeholder="Model, size, capacity\u2026" value="' + esc(r.sp || '') + '"></div>';
  }

  h += '<div class="exp-label">Note</div><div class="field">' +
    '<input class="field-in" type="text" data-fld="n" data-id="' + it.id +
    '" placeholder="Condition, where it lives, what to buy\u2026" value="' + esc(r.n || '') + '"></div>';

  h += '<div class="exp-label">Estimated cost to buy</div><div class="field cost-wrap">' +
    '<span class="cost-sign">$</span>' +
    '<input class="field-in" type="number" inputmode="decimal" min="0" step="1" data-fld="c" data-id="' + it.id +
    '" placeholder="0" value="' + (typeof r.c === 'number' ? r.c : '') + '"></div>';

  h += '<div class="buy-meta">' + esc(entry.sub.num + ' ' + entry.sub.title) + ' \u00b7 ' + esc(it.store) +
    (it.phase !== null ? ' \u00b7 phase ' + it.phase : '') + '</div>';
  h += '</div>';
  return h;
}

/* ---------------- buy list ---------------- */

function buyEntries() {
  var out = [];
  for (var i = 0; i < flat.length; i++) {
    var e = flat[i], st = statusOf(e.item.id);
    var kind = null;
    if (GAPS[st]) kind = st;
    else if (isRestock(e)) kind = 'restock';
    if (!kind) continue;
    out.push({ e: e, kind: kind });
  }
  var rank = { blocking: 0, missing: 2, upgrade: 3, restock: 4 };
  out.sort(function (a, b) {
    var ra = rank[a.kind], rb = rank[b.kind];
    var sa = a.e.item.tags.indexOf('safety') >= 0 ? 1 : 0;
    var sb = b.e.item.tags.indexOf('safety') >= 0 ? 1 : 0;
    if (ra !== rb) return ra - rb;
    if (sa !== sb) return sb - sa;
    var pa = a.e.item.phase === null ? 1 : a.e.item.phase;
    var pb = b.e.item.phase === null ? 1 : b.e.item.phase;
    if (pa !== pb) return pa - pb;
    return a.e.sec.num - b.e.sec.num;
  });
  return out;
}

function viewBuy() {
  var list = buyEntries();
  var total = 0, priced = 0;
  for (var i = 0; i < list.length; i++) {
    var c = costOf(list[i].e.item.id);
    if (c) { total += c; priced++; }
  }

  var h = '';
  h += '<div class="total-bar"><div><div class="total-num">' + money(total) + '</div>' +
    '<div class="total-label">estimated</div></div>' +
    '<div class="total-count">' + list.length + ' items<br>' + priced + ' priced</div></div>';

  h += '<div class="chips" style="padding:9px 14px 0">' +
    groupChip('priority', 'By priority') + groupChip('store', 'By store') +
    groupChip('section', 'By section') + '</div>';

  if (!list.length) {
    h += '<div class="empty"><strong>Nothing on the list yet</strong>' +
      'Mark items as Missing, Upgrade, or Blocking and they collect here.</div>';
    document.getElementById('view').innerHTML = h;
    setNav('buy');
    return;
  }

  var groups = {}, order = [];
  for (var j = 0; j < list.length; j++) {
    var row = list[j], key;
    if (prefs.group === 'store') key = row.e.item.store;
    else if (prefs.group === 'section') key = row.e.sec.num + '. ' + row.e.sec.title;
    else key = groupLabel(row);
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(row);
  }

  for (var k = 0; k < order.length; k++) {
    var name = order[k], rows = groups[name], sum = 0;
    for (var m = 0; m < rows.length; m++) { var cc = costOf(rows[m].e.item.id); if (cc) sum += cc; }
    h += '<div class="group-head"><span class="group-name">' + esc(name) + '</span>' +
      '<span class="group-sum">' + rows.length + ' \u00b7 ' + money(sum) + '</span></div>';
    for (var n = 0; n < rows.length; n++) h += buyRow(rows[n]);
  }

  h += '<div class="btn-row" style="margin-top:16px">' +
    '<button type="button" class="btn" data-act="copy-md">Copy as markdown</button>' +
    '<button type="button" class="btn" data-act="dl-csv">Download CSV</button></div>';

  document.getElementById('view').innerHTML = h;
  setNav('buy');
  window.scrollTo(0, 0);
}

function groupChip(g, label) {
  return '<button type="button" class="chip" data-act="group" data-group="' + g +
    '" aria-pressed="' + (prefs.group === g) + '">' + esc(label) + '</button>';
}

function groupLabel(row) {
  if (row.kind === 'blocking') return 'Blocking';
  if (row.e.item.tags.indexOf('safety') >= 0) return 'Safety';
  if (row.kind === 'missing') return 'Missing';
  if (row.kind === 'upgrade') return 'Upgrade';
  return 'Restock';
}

function buyRow(row) {
  var it = row.e.item;
  var c = costOf(it.id);
  var meta = row.e.sec.num + '.' + ' ' + row.e.sub.title + ' \u00b7 ' + it.store;
  if (row.kind === 'restock') {
    var q = qtyOf(it.id);
    meta = 'have ' + (q === null ? 0 : q) + ' of ' + it.target + ' \u00b7 ' + it.store;
  }
  return '<div class="buy-item" data-item="' + it.id + '">' +
    '<span class="buy-mark" data-s="' + row.kind + '"></span>' +
    '<span class="buy-main"><span class="buy-label">' + esc(it.label) + '</span>' +
    '<span class="buy-meta">' + esc(meta) + '</span></span>' +
    '<input class="buy-cost" type="number" inputmode="decimal" min="0" step="1" data-fld="c" data-id="' +
    it.id + '" placeholder="$" value="' + (typeof c === 'number' ? c : '') + '">' +
    '<button type="button" class="buy-got" data-act="got" data-id="' + it.id +
    '" aria-label="Mark as bought">\u2713</button></div>';
}

/* ---------------- settings ---------------- */

function viewSettings() {
  var s = stats();
  var h = '';

  h += '<div class="wrap"><div class="eyebrow">Data</div></div>';
  h += '<div class="card"><h2>Back up the audit</h2>' +
    '<p>Everything lives in this browser only. Export after a long session so a cleared cache cannot cost you the work.</p>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button type="button" class="btn" data-act="dl-json">Download JSON</button>' +
    '<button type="button" class="btn" data-act="dl-md">Download markdown</button>' +
    '<button type="button" class="btn" data-act="dl-csv">Download CSV</button>' +
    '</div></div>';

  h += '<div class="card"><h2>Restore from a backup</h2>' +
    '<p>Loads a JSON export and merges it in. Newer marks win per item.</p>' +
    '<input type="file" id="importFile" accept="application/json" class="field-in" style="padding:9px"></div>';

  h += '<div class="card"><h2>Tally</h2>' +
    kv('Items in checklist', s.total) +
    kv('Audited', s.audited + ' (' + Math.round(s.audited / s.total * 100) + '%)') +
    kv('Have', s.have) +
    kv('Gaps', s.gap) +
    kv('Blocking', s.blocking) +
    kv('Safety gaps', s.safety) +
    kv('Restock', s.restock) +
    kv('Out of scope', s.na) +
    kv('Not audited', s.unknown) +
    kv('Estimated buy cost', money(s.cost)) +
    '</div>';

  h += '<div class="card"><h2>Display</h2>' +
    '<div class="switch-row"><span><span class="lbl">Light theme</span>' +
    '<span class="hint">Dark is the default for shop lighting.</span></span>' +
    '<button type="button" class="toggle" data-act="theme" aria-pressed="' + (prefs.theme === 'light') + '" aria-label="Light theme"></button></div>' +
    '<div class="switch-row" style="border-top:1px solid var(--line)"><span><span class="lbl">Keep screen awake</span>' +
    '<span class="hint">Stops the phone sleeping mid-drawer.</span></span>' +
    '<button type="button" class="toggle" data-act="wake" aria-pressed="' + (prefs.wake ? 'true' : 'false') + '" aria-label="Keep screen awake"></button></div>' +
    '</div>';

  h += '<div class="card"><h2>Start over</h2>' +
    '<p>Clears every mark, quantity, note, and cost. The checklist itself stays.</p>' +
    '<button type="button" class="btn btn-danger btn-block" data-act="reset">Clear all marks</button></div>';

  h += '<div class="wrap"><p class="sub" style="margin-top:18px">Checklist generated ' +
    esc(seed.generated) + ' \u00b7 ' + s.total + ' items \u00b7 v' + seed.version + '</p></div>';

  document.getElementById('view').innerHTML = h;
  setNav('settings');
  window.scrollTo(0, 0);
}

function kv(k, v) {
  return '<div class="kv"><span>' + esc(k) + '</span><span>' + esc(v) + '</span></div>';
}

/* ---------------- exports ---------------- */

function download(name, text, type) {
  var blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

function exportMarkdown() {
  var s = stats();
  var out = ['# Shop Inventory Audit', '', 'Audited ' + s.audited + ' of ' + s.total +
    '. Have ' + s.have + ', gaps ' + s.gap + ', blocking ' + s.blocking +
    ', restock ' + s.restock + '. Estimated cost ' + money(s.cost) + '.',
    '', 'Exported ' + stamp(), ''];

  for (var i = 0; i < seed.sections.length; i++) {
    var sec = seed.sections[i];
    out.push('## ' + sec.num + '. ' + sec.title, '');
    for (var j = 0; j < sec.subsections.length; j++) {
      var sub = sec.subsections[j];
      out.push('### ' + sub.num + ' ' + sub.title);
      for (var k = 0; k < sub.items.length; k++) {
        var it = sub.items[k];
        var st = statusOf(it.id), r = rec(it.id) || {};
        var box = st === 'have' ? 'x' : ' ';
        var line = '- [' + box + '] ' + it.label;
        var bits = [];
        if (st !== 'unknown' && st !== 'have') bits.push(SLABEL[st].toUpperCase());
        var q = qtyOf(it.id);
        if (it.qty && q !== null) {
          bits.push('qty ' + q + (it.target ? '/' + it.target : ''));
        } else if (it.qty && it.target && st !== 'unknown') {
          bits.push('not counted, target ' + it.target);
        }
        if (r.sp) bits.push('spec: ' + r.sp);
        if (r.n) bits.push('note: ' + r.n);
        if (typeof r.c === 'number') bits.push('est $' + r.c);
        if (bits.length) line += '  `' + bits.join(' | ') + '`';
        out.push(line);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

function exportBuyMarkdown() {
  var list = buyEntries();
  var total = 0;
  for (var i = 0; i < list.length; i++) { var c = costOf(list[i].e.item.id); if (c) total += c; }
  var out = ['# Shop buy list', '', list.length + ' items, ' + money(total) + ' estimated. ' + stamp(), ''];
  var lastGroup = '';
  for (var j = 0; j < list.length; j++) {
    var row = list[j];
    var g = prefs.group === 'store' ? row.e.item.store
      : prefs.group === 'section' ? row.e.sec.num + '. ' + row.e.sec.title
        : groupLabel(row);
    if (g !== lastGroup) {
      if (lastGroup) out.push('');
      out.push('## ' + g, '');
      lastGroup = g;
    }
    var c2 = costOf(row.e.item.id);
    out.push('- [ ] ' + row.e.item.label +
      (row.kind === 'restock' && row.e.item.target
        ? ' (have ' + (qtyOf(row.e.item.id) || 0) + ' of ' + row.e.item.target + ')' : '') +
      (c2 ? ' \u2014 $' + c2 : ''));
  }
  return out.join('\n').replace(/\u2014/g, '-');
}

function exportCsv() {
  var rows = [['id', 'section', 'subsection', 'item', 'status', 'qty', 'target',
    'spec', 'note', 'est_cost', 'store', 'phase', 'tags']];
  for (var i = 0; i < flat.length; i++) {
    var e = flat[i], it = e.item, r = rec(it.id) || {};
    rows.push([it.id, e.sec.num + '. ' + e.sec.title, e.sub.num + ' ' + e.sub.title, it.label,
      statusOf(it.id), qtyOf(it.id) === null ? '' : qtyOf(it.id), it.target || '',
      r.sp || '', r.n || '', typeof r.c === 'number' ? r.c : '', it.store,
      it.phase === null ? '' : it.phase, it.tags.join(' ')]);
  }
  return rows.map(function (r) {
    return r.map(function (c) {
      var s = String(c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\n');
}

function copyText(text, msg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { toast(msg); }, function () {
      download('shop-buy-list-' + stamp() + '.md', text, 'text/markdown');
    });
  } else {
    download('shop-buy-list-' + stamp() + '.md', text, 'text/markdown');
  }
}

/* ---------------- interaction ---------------- */

function patchItemDom(id) {
  var wrap = document.querySelector('[data-item="' + id + '"]');
  if (!wrap) return;
  var st = statusOf(id);
  wrap.setAttribute('data-status', st);
  var btn = wrap.querySelector('.status');
  if (btn) {
    btn.setAttribute('data-s', st);
    btn.textContent = GLYPH[st];
    btn.classList.add('pulse');
    setTimeout(function () { btn.classList.remove('pulse'); }, 110);
  }
  var sets = wrap.querySelectorAll('.set-btn');
  for (var i = 0; i < sets.length; i++) {
    sets[i].setAttribute('aria-pressed', String(sets[i].getAttribute('data-sv') === st));
  }
}

function currentSection() {
  var m = /^#\/s\/(.+)$/.exec(location.hash);
  if (!m) return null;
  for (var i = 0; i < seed.sections.length; i++) {
    if (seed.sections[i].id === m[1]) return seed.sections[i];
  }
  return null;
}

function onClick(ev) {
  var t = ev.target.closest ? ev.target.closest('[data-act]') : null;
  if (!t) return;
  var act = t.getAttribute('data-act');
  var id = t.getAttribute('data-id');

  if (act === 'cycle') {
    var cur = statusOf(id);
    var next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
    setStatus(id, next);
    patchItemDom(id);
    paintPlate();
    toast(SLABEL[next] + ': ' + shortLabel(id), true);
    return;
  }

  if (act === 'set') {
    setStatus(id, t.getAttribute('data-s'));
    patchItemDom(id);
    paintPlate();
    return;
  }

  if (act === 'expand') {
    ui.open = ui.open === id ? null : id;
    var sec = currentSection();
    if (sec) renderList(sec); else renderGlobalResults();
    if (ui.open) {
      var el = document.querySelector('[data-item="' + ui.open + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
    return;
  }

  if (act === 'qty') {
    var d = parseInt(t.getAttribute('data-d'), 10);
    var q = qtyOf(id);
    var nv = Math.max(0, (q === null ? 0 : q) + d);
    var r = touch(id);
    r.q = nv;
    persist();
    var val = document.querySelector('[data-qtyval="' + id + '"]');
    if (val) val.textContent = nv;
    var inline = document.querySelector('[data-item="' + id + '"] .qty-inline');
    if (inline) {
      var it = index[id].item;
      inline.textContent = nv;
      if (it.target && nv < it.target) inline.classList.add('qty-low');
      else inline.classList.remove('qty-low');
    }
    paintPlate();
    return;
  }

  if (act === 'collapse') {
    var sid = t.getAttribute('data-sub');
    ui.collapsed[sid] = !ui.collapsed[sid];
    var s1 = currentSection();
    if (s1) renderList(s1);
    return;
  }

  if (act === 'bulk') {
    var sub = null, sec2 = currentSection();
    if (!sec2) return;
    for (var i = 0; i < sec2.subsections.length; i++) {
      if (sec2.subsections[i].id === t.getAttribute('data-sub')) sub = sec2.subsections[i];
    }
    if (!sub) return;
    var changed = [];
    for (var j = 0; j < sub.items.length; j++) {
      if (statusOf(sub.items[j].id) === 'unknown') {
        setStatus(sub.items[j].id, 'have', false);
        changed.push(sub.items[j].id);
      }
    }
    lastChange = { bulk: changed };
    renderList(sec2);
    paintPlate();
    toast('Marked ' + changed.length + ' as Have in ' + sub.num, true);
    return;
  }

  if (act === 'chip') {
    ui.filter = t.getAttribute('data-filter');
    var s3 = currentSection();
    if (s3) { viewSection(s3.id); }
    return;
  }

  if (act === 'group') {
    prefs.group = t.getAttribute('data-group');
    persist();
    viewBuy();
    return;
  }

  if (act === 'got') {
    setStatus(id, 'have');
    var it2 = index[id].item;
    if (it2.qty && it2.target) { touch(id).q = it2.target; }
    persist();
    viewBuy();
    paintPlate();
    toast('Bought: ' + shortLabel(id), true);
    return;
  }

  if (act === 'theme') {
    prefs.theme = prefs.theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', prefs.theme);
    document.querySelector('meta[name=theme-color]')
      .setAttribute('content', prefs.theme === 'light' ? '#e6e4de' : '#14181b');
    persist();
    viewSettings();
    return;
  }

  if (act === 'wake') {
    prefs.wake = !prefs.wake;
    persist();
    applyWakeLock();
    viewSettings();
    return;
  }

  if (act === 'reset') {
    if (!window.confirm('Clear every mark, quantity, note, and cost? This cannot be undone.')) return;
    user = {};
    lastChange = null;
    persist();
    location.hash = '#/';
    route();
    paintPlate();
    toast('All marks cleared');
    return;
  }

  if (act === 'dl-json') {
    download('shop-inventory-' + stamp() + '.json',
      JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), user: user, prefs: prefs }, null, 2),
      'application/json');
    toast('Backup downloaded');
    return;
  }

  if (act === 'dl-md') {
    download('shop-inventory-audit-' + stamp() + '.md', exportMarkdown(), 'text/markdown');
    toast('Markdown downloaded');
    return;
  }

  if (act === 'dl-csv') {
    download('shop-inventory-' + stamp() + '.csv', exportCsv(), 'text/csv');
    toast('CSV downloaded');
    return;
  }

  if (act === 'copy-md') {
    copyText(exportBuyMarkdown(), 'Buy list copied');
    return;
  }
}

function shortLabel(id) {
  var l = index[id].item.label;
  return l.length > 34 ? l.slice(0, 33) + '\u2026' : l;
}

var searchTimer = null;
function onInput(ev) {
  var el = ev.target;

  if (el.id === 'secSearch' || el.id === 'globalSearch') {
    ui.query = el.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      var sec = currentSection();
      if (sec) renderList(sec); else renderGlobalResults();
    }, 140);
    return;
  }

  var fld = el.getAttribute && el.getAttribute('data-fld');
  if (fld) {
    var id = el.getAttribute('data-id');
    var r = touch(id);
    if (fld === 'c') {
      var v = parseFloat(el.value);
      if (isNaN(v) || v < 0) delete r.c; else r.c = v;
    } else {
      if (el.value.trim() === '') delete r[fld]; else r[fld] = el.value;
    }
    persist();
    return;
  }

  if (el.id === 'importFile' && el.files && el.files[0]) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var data = JSON.parse(String(fr.result));
        var incoming = data.user || data;
        var merged = 0;
        for (var key in incoming) {
          if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
          if (!index[key]) continue;
          var a = user[key], b = incoming[key];
          if (!a || !a.u || (b.u && b.u > a.u)) { user[key] = b; merged++; }
        }
        if (data.prefs && data.prefs.theme) {
          prefs.theme = data.prefs.theme;
          document.documentElement.setAttribute('data-theme', prefs.theme);
        }
        persist();
        viewSettings();
        paintPlate();
        toast('Restored ' + merged + ' items');
      } catch (e) {
        toast('That file is not a valid backup');
      }
    };
    fr.readAsText(el.files[0]);
  }
}

function undo() {
  if (!lastChange) return;
  if (lastChange.bulk) {
    for (var i = 0; i < lastChange.bulk.length; i++) setStatus(lastChange.bulk[i], 'unknown', false);
  } else {
    setStatus(lastChange.id, lastChange.prev, false);
  }
  lastChange = null;
  document.getElementById('toast').hidden = true;
  route();
  paintPlate();
}

function applyWakeLock() {
  if (!prefs.wake) {
    if (wakeSentinel && wakeSentinel.release) { wakeSentinel.release(); wakeSentinel = null; }
    return;
  }
  if (!navigator.wakeLock || !navigator.wakeLock.request) return;
  navigator.wakeLock.request('screen').then(function (s) {
    wakeSentinel = s;
    s.addEventListener('release', function () { wakeSentinel = null; });
  })['catch'](function () { /* denied or unsupported */ });
}

/* ---------------- routing ---------------- */

function route() {
  var h = location.hash || '#/';
  if (h.indexOf('#/s/') === 0) {
    var id = h.slice(4);
    ui.open = null;
    viewSection(id);
  } else if (h === '#/buy') {
    ui.open = null;
    viewBuy();
  } else if (h === '#/settings') {
    viewSettings();
  } else {
    viewIndex();
  }
  paintPlate();
}

/* ---------------- boot ---------------- */

function buildIndex() {
  flat = [];
  index = {};
  for (var i = 0; i < seed.sections.length; i++) {
    var sec = seed.sections[i];
    for (var j = 0; j < sec.subsections.length; j++) {
      var sub = sec.subsections[j];
      for (var k = 0; k < sub.items.length; k++) {
        var entry = { item: sub.items[k], sec: sec, sub: sub };
        index[sub.items[k].id] = entry;
        flat.push(entry);
      }
    }
  }
}

function boot() {
  fetch('data/checklist.md', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('checklist ' + r.status);
      return r.text();
    })
    .then(function (text) {
      seed = parseChecklist(text);
      buildIndex();
      return loadSaved();
    })
    .then(function (saved) {
      if (saved) {
        if (saved.user) user = saved.user;
        if (saved.prefs) {
          if (saved.prefs.theme) prefs.theme = saved.prefs.theme;
          if (typeof saved.prefs.wake === 'boolean') prefs.wake = saved.prefs.wake;
          if (saved.prefs.group) prefs.group = saved.prefs.group;
        }
      }
      document.documentElement.setAttribute('data-theme', prefs.theme);
      document.querySelector('meta[name=theme-color]')
        .setAttribute('content', prefs.theme === 'light' ? '#e6e4de' : '#14181b');

      document.getElementById('view').addEventListener('click', onClick);
      document.getElementById('view').addEventListener('input', onInput);
      document.getElementById('view').addEventListener('change', onInput);
      document.getElementById('toastUndo').addEventListener('click', undo);
      window.addEventListener('hashchange', route);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && prefs.wake) applyWakeLock();
      });

      applyWakeLock();
      route();
      var boot = document.getElementById('boot');
      if (boot) boot.parentNode.removeChild(boot);
    })
    ['catch'](function (err) {
      var b = document.getElementById('boot');
      if (b) b.textContent = 'Could not load the checklist. Reload the page.';
      if (window.console) console.error(err);
    });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js')['catch'](function () { /* offline still fine */ });
  });
}

boot();
