const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing session token' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid session' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Returns true if the user's plan currently grants paid (unlimited) access.
function isPlanActive(user) {
  if (user.plan === 'perm') return true;
  if (user.plan === 'free') {
    const expires = new Date(user.created_at);
    expires.setDate(expires.getDate() + 30);
    return new Date() < expires;
  }
  // '3mo' / 'annual'
  return user.plan_expires_at && new Date(user.plan_expires_at) > new Date();
}

module.exports = { requireAuth, requireAdmin, isPlanActive };
