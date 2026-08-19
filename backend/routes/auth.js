const express = require('express');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../db/pool');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ---------------------------------------------------------------------------
// Frontend flow (see login.html):
//   1. Google Identity Services renders the "Continue with Google" button.
//   2. On success, Google gives the browser a signed `credential` (ID token).
//   3. Frontend POSTs { credential } here.
//   4. We verify it really came from Google, then find-or-create the user
//      by their Google email — no OTP, no password, ever.
// ---------------------------------------------------------------------------

router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(422).json({ error: 'Missing Google credential' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Google credential' });
  }

  const { sub: googleId, email, name, picture, email_verified } = payload;
  if (!email_verified) return res.status(403).json({ error: 'Google email is not verified' });

  // Find by google_id first, fall back to email (covers a user who somehow
  // already exists by email but hasn't linked google_id yet).
  let { rows } = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
  let user = rows[0];

  if (!user) {
    const byEmail = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (byEmail.rows[0]) {
      const updated = await pool.query(
        `UPDATE users SET google_id=$1, name=$2, avatar_url=$3 WHERE id=$4 RETURNING *`,
        [googleId, name, picture, byEmail.rows[0].id]
      );
      user = updated.rows[0];
    } else {
      const created = await pool.query(
        `INSERT INTO users (email, google_id, name, avatar_url) VALUES ($1,$2,$3,$4) RETURNING *`,
        [email, googleId, name, picture]
      );
      user = created.rows[0];
    }
  }

  if (user.status === 'suspended') return res.status(403).json({ error: 'This account has been suspended' });

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, plan: user.plan, is_admin: user.is_admin },
  });
});

// GET /api/auth/me — used by the dashboard/admin on load to confirm the
// stored token is still valid and to get fresh user info.
router.get('/me', async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    res.json({ user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, plan: user.plan, is_admin: user.is_admin } });
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
});

module.exports = router;
