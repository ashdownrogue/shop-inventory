const { clearSessionCookie } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
};
