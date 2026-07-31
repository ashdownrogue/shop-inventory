// Passphrase check + stateless signed-cookie sessions for the sync API.
// No user accounts, no session table -- one shared passphrase per the plan.

const crypto = require('crypto');

const COOKIE_NAME = 'shop_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// SHOP_PASSPHRASE_HASH is "salt:hashHex", generated once with:
//   node -e "const c=require('crypto'),s=c.randomBytes(16).toString('hex');
//   console.log(s+':'+c.scryptSync(process.argv[1],s,64).toString('hex'))" '<passphrase>'
function verifyPassphrase(input) {
  const stored = process.env.SHOP_PASSPHRASE_HASH;
  if (!stored || !input) return false;
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(input, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function makeSessionToken() {
  const secret = process.env.SESSION_SECRET;
  const expires = String(Date.now() + SESSION_MS);
  return `${expires}.${sign(expires, secret)}`;
}

function verifySessionToken(token) {
  const secret = process.env.SESSION_SECRET;
  if (!token || !secret) return false;
  const [expires, mac] = token.split('.');
  if (!expires || !mac) return false;
  const expected = sign(expires, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(expires) > Date.now();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i === -1) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function requireSession(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

function setSessionCookie(res) {
  const token = makeSessionToken();
  const maxAge = Math.floor(SESSION_MS / 1000);
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  verifyPassphrase,
  requireSession,
  setSessionCookie,
  clearSessionCookie,
};
