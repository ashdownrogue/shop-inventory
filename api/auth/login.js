const { verifyPassphrase, setSessionCookie } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const passphrase = body && body.passphrase;
  if (!verifyPassphrase(passphrase)) {
    res.status(401).json({ error: 'wrong passphrase' });
    return;
  }

  setSessionCookie(res);
  res.status(200).json({ ok: true });
};
