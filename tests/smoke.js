const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = './';
const md = fs.readFileSync(path + 'data/checklist.md', 'utf8');

const dom = new JSDOM(fs.readFileSync(path + 'index.html', 'utf8'), {
  runScripts: 'outside-only', url: 'https://example.test/', pretendToBeVisual: true
});
const w = dom.window;

// stubs
w.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve(md) });
w.indexedDB = undefined;
w.localStorage.setItem = () => {};
w.localStorage.getItem = () => null;
w.navigator.wakeLock = undefined;
w.URL.createObjectURL = () => 'blob:x';
w.URL.revokeObjectURL = () => {};
w.confirm = () => true;
const errors = [];
w.addEventListener('error', e => errors.push('window error: ' + e.message));
w.console.error = (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300));

w.eval(fs.readFileSync(path + 'app.js', 'utf8'));

setTimeout(() => {
  const d = w.document;
  const q = (s) => d.querySelector(s);
  const qa = (s) => Array.from(d.querySelectorAll(s));
  const log = [];
  const check = (name, cond, extra) => log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : ''));

  check('boot overlay removed', !q('#boot'));
  check('tally total is 1534', q('#tallyTotal').textContent === '1534', q('#tallyTotal').textContent);
  check('index rendered sections', qa('.sec-row').length === 19, String(qa('.sec-row').length));
  check('legend rendered', qa('.legend-cell').length === 6);
  check('placards rendered', qa('.placard').length === 3);
  check('resume button present', !!q('.btn-primary'));

  // navigate to sockets section
  w.location.hash = '#/s/s03';
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));
  const items = qa('.item');
  check('section 03 renders items', items.length > 200, String(items.length));
  check('toolbar chips render', qa('.chip').length === 7, String(qa('.chip').length));

  // cycle a status 3 times: unknown -> have -> missing -> upgrade
  const first = q('.status');
  const id = first.getAttribute('data-id');
  first.click();
  check('cycle 1 -> have', q('[data-item="' + id + '"] .status').getAttribute('data-s') === 'have',
        q('[data-item="' + id + '"] .status').getAttribute('data-s'));
  q('[data-item="' + id + '"] .status').click();
  check('cycle 2 -> missing', q('[data-item="' + id + '"] .status').getAttribute('data-s') === 'missing');
  check('tally incremented', q('#tallyDone').textContent === '1', q('#tallyDone').textContent);
  check('buy badge shows 1 gap', !q('#buyBadge').hidden && q('#buyBadge').textContent === '1', q('#buyBadge').textContent);

  // expander
  q('[data-item="' + id + '"] .item-body').click();
  check('expander opens', !!q('[data-item="' + id + '"] .exp'));
  check('set buttons render', qa('[data-item="' + id + '"] .set-btn').length === 5);
  // explicit set to blocking
  const setBtn = qa('[data-item="' + id + '"] .set-btn').find(b => b.getAttribute('data-s') === 'blocking');
  setBtn.click();
  check('explicit set -> blocking', q('[data-item="' + id + '"] .status').getAttribute('data-s') === 'blocking');

  // note field
  const noteIn = q('[data-item="' + id + '"] [data-fld="n"]');
  noteIn.value = 'need 2 of these';
  noteIn.dispatchEvent(new w.Event('input', { bubbles: true }));

  // subsection collapse (re-query each time: the list re-renders)
  const itemsBefore = qa('.item').length;
  q('.subsec-head').click();
  check('collapse hides items', qa('.item').length < itemsBefore,
        itemsBefore + ' -> ' + qa('.item').length);
  q('.subsec-head').click();
  check('expand restores items', qa('.item').length === itemsBefore,
        String(qa('.item').length));

  // bulk mark
  const bulk = q('.bulk');
  const before = Number(q('#tallyDone').textContent);
  if (bulk) { bulk.click(); }
  const after = Number(q('#tallyDone').textContent);
  check('bulk mark increases audited', after > before, before + ' -> ' + after);

  // restock must not fire until a consumable is actually counted
  w.location.hash = '#/s/s12';
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));
  const freshBadge = q('#buyBadge').textContent;
  check('unaudited consumables stay off buy list', freshBadge === '1', 'badge ' + freshBadge);
  const consumChip = qa('.chip').find(c => c.getAttribute('data-filter') === 'consumable');
  consumChip.click();
  const cItem = q('.item');
  const cid = cItem.getAttribute('data-item');
  cItem.querySelector('.item-body').click();
  const minus = q('[data-item="' + cid + '"] [data-d="1"]');
  if (minus) { minus.click(); }
  check('counting a consumable below target adds restock', Number(q('#buyBadge').textContent) >= 2,
        'badge ' + q('#buyBadge').textContent);
  qa('.chip').find(c => c.getAttribute('data-filter') === 'all').click();
  w.location.hash = '#/s/s03';
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));

  // filters
  const gapsChip = qa('.chip').find(c => c.getAttribute('data-filter') === 'gaps');
  gapsChip.click();
  check('gaps filter shows only gaps', qa('.item').length >= 1 && qa('.item[data-status="have"]').length === 0,
        'items ' + qa('.item').length + ' / have ' + qa('.item[data-status="have"]').length);
  qa('.chip').find(c => c.getAttribute('data-filter') === 'all').click();

  // search within section
  const s = q('#secSearch');
  s.value = '19 mm';
  s.dispatchEvent(new w.Event('input', { bubbles: true }));
  setTimeout(() => {
    check('section search filters', qa('.item').length > 0 && qa('.item').length < 60, String(qa('.item').length));

    // buy view
    w.location.hash = '#/buy';
    w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    check('buy list renders rows', qa('.buy-item').length >= 1, String(qa('.buy-item').length));
    check('buy total bar present', !!q('.total-num'), q('.total-num') && q('.total-num').textContent);

    // set a cost
    const costIn = q('.buy-cost');
    costIn.value = '42';
    costIn.dispatchEvent(new w.Event('input', { bubbles: true }));
    w.location.hash = '#/settings';
    w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    w.location.hash = '#/buy';
    w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    check('cost persists into total', q('.total-num').textContent.indexOf('42') >= 0, q('.total-num').textContent);

    // group toggles
    qa('.chip').find(c => c.getAttribute('data-group') === 'store').click();
    check('group by store works', qa('.group-head').length >= 1);

    // mark bought
    const got = q('.buy-got');
    if (got) got.click();

    // settings + exports
    w.location.hash = '#/settings';
    w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    check('settings renders tally rows', qa('.kv').length >= 10, String(qa('.kv').length));
    check('toggles render', qa('.toggle').length === 2);
    qa('[data-act="dl-md"]')[0].click();
    qa('[data-act="dl-csv"]')[0].click();
    qa('[data-act="dl-json"]')[0].click();
    check('theme toggle flips', (qa('[data-act="theme"]')[0].click(), d.documentElement.getAttribute('data-theme') === 'light'),
          d.documentElement.getAttribute('data-theme'));

    // global search on index
    w.location.hash = '#/';
    w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    const gs = q('#globalSearch');
    gs.value = 'tourniquet';
    gs.dispatchEvent(new w.Event('input', { bubbles: true }));
    setTimeout(() => {
      check('global search finds item', qa('#globalResults .item').length >= 1, String(qa('#globalResults .item').length));

      // undo
      w.location.hash = '#/s/s01';
      w.dispatchEvent(new w.HashChangeEvent('hashchange'));
      q('.status').click();
      const undoBtn = d.getElementById('toastUndo');
      const beforeUndo = q('#tallyDone').textContent;
      undoBtn.click();
      check('undo reverts', q('#tallyDone').textContent !== beforeUndo, beforeUndo + ' -> ' + q('#tallyDone').textContent);

      console.log(log.join('\n'));
      console.log('\nerrors captured: ' + errors.length);
      errors.slice(0, 8).forEach(e => console.log('  ' + e));
      const fails = log.filter(l => l.startsWith('FAIL'));
      console.log('\n' + (fails.length ? fails.length + ' FAILURES' : 'ALL ' + log.length + ' CHECKS PASSED'));
      process.exit(fails.length || errors.length ? 1 : 0);
    }, 260);
  }, 260);
}, 400);
