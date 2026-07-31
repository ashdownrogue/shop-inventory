const { requireSession } = require('../lib/auth');
const {
  getChangedSince,
  upsertSections,
  upsertSubsections,
  upsertItems,
  upsertMarks,
} = require('../lib/db');

// Bidirectional sync: push whatever changed locally since `since`, then
// pull back everything that changed server-side (including other
// devices' writes) in the same window. Last-write-wins is enforced in
// lib/db.js's upserts, not trusted from the client.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  if (!requireSession(req)) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  try {
    // Order matters: sections before subsections before items, so
    // foreign keys resolve even when a device pushes a brand-new
    // section/subsection/item all in one sync.
    await upsertSections(body.sections || []);
    await upsertSubsections(body.subsections || []);
    await upsertItems(body.items || []);
    await upsertMarks(body.marks || []);

    const now = new Date().toISOString();
    const changed = await getChangedSince(body.since);

    res.status(200).json({
      sections: changed.sections,
      subsections: changed.subsections,
      items: changed.items,
      marks: changed.marks,
      now: now,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'sync failed' });
  }
};
