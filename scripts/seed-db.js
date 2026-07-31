#!/usr/bin/env node
// One-time migration: parses data/checklist.md with the exact same logic
// parseChecklist() in app.js uses, and inserts the result into Postgres
// with those content-derived ids frozen in place forever. Run once,
// after applying db/schema.sql, with DATABASE_URL set:
//
//   node scripts/seed-db.js
//
// Safe to re-run: sections/subsections/items are inserted with
// ON CONFLICT DO NOTHING, so it never overwrites rows a device has
// since edited through the app.

const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Pull it from Vercel (`vercel env pull`) or\n' +
                'copy the connection string from the Neon integration, then re-run.');
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);

const CHECKLIST_PATH = path.join(__dirname, '..', 'data', 'checklist.md');
const FACTORY_TS = new Date(0).toISOString(); // predates any real edit

// ---- ported verbatim from app.js's parseChecklist() / classifyStore() /
// slugify() so the ids produced here match what every already-deployed
// browser has already computed and stored marks against. ----

const STORE_RULES = [
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
    'die', 'socket', 'wrench', 'plier', 'screwdriver', 'file', 'saw', 'extension', 'ratchet']],
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
    out.push(s2);
  }
  return out;
}

// ---- insert ----

async function main() {
  const text = fs.readFileSync(CHECKLIST_PATH, 'utf8');
  const sections = parseChecklist(text);

  let secCount = 0, subCount = 0, itemCount = 0;

  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    await sql`
      INSERT INTO sections (id, num, title, sort_order, updated_at)
      VALUES (${sec.id}, ${sec.num}, ${sec.title}, ${si}, ${FACTORY_TS})
      ON CONFLICT (id) DO NOTHING`;
    secCount++;

    for (let bi = 0; bi < sec.subsections.length; bi++) {
      const sub = sec.subsections[bi];
      await sql`
        INSERT INTO subsections (id, section_id, num, title, sort_order, updated_at)
        VALUES (${sub.id}, ${sec.id}, ${sub.num}, ${sub.title}, ${bi}, ${FACTORY_TS})
        ON CONFLICT (id) DO NOTHING`;
      subCount++;

      for (let ii = 0; ii < sub.items.length; ii++) {
        const it = sub.items[ii];
        await sql`
          INSERT INTO items (id, subsection_id, label, qty, target, spec,
                              phase, tags, store, sort_order, updated_at)
          VALUES (${it.id}, ${sub.id}, ${it.label}, ${it.qty}, ${it.target},
                  ${it.spec}, ${it.phase}, ${it.tags}, ${it.store}, ${ii}, ${FACTORY_TS})
          ON CONFLICT (id) DO NOTHING`;
        itemCount++;
      }
    }
  }

  console.log(`sections:    ${secCount}`);
  console.log(`subsections: ${subCount}`);
  console.log(`items:       ${itemCount}`);
}

main().then(function () {
  process.exit(0);
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
