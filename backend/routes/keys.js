const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth, isPlanActive } = require('../middleware/auth');

const router = express.Router();
const FREE_TIER_KEY_LIMIT = 5;

function generateKey() {
  const full = 'vp_live_' + crypto.randomBytes(24).toString('base64url');
  const hash = crypto.createHash('sha256').update(full).digest('hex');
  const prefix = full.slice(0, 16); // safe to display without revealing the rest
  return { full, hash, prefix };
}

// GET /api/keys — list the caller's keys (masked)
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, key_prefix, revoked, created_at FROM api_keys
     WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ keys: rows });
});

// POST /api/keys — create a new key. Enforces the free-tier 5 key cap.
router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(422).json({ error: 'Key name is required' });

  const paid = isPlanActive(req.user) && req.user.plan !== 'free';

  if (!paid) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM api_keys WHERE user_id = $1 AND revoked = FALSE`,
      [req.user.id]
    );
    if (rows[0].count >= FREE_TIER_KEY_LIMIT) {
      return res.status(403).json({
        error: `Free plan is limited to ${FREE_TIER_KEY_LIMIT} active API keys. Upgrade for unlimited keys.`,
      });
    }
  }

  const { full, hash, prefix } = generateKey();
  const { rows } = await pool.query(
    `INSERT INTO api_keys (user_id, name, key_prefix, key_hash)
     VALUES ($1,$2,$3,$4) RETURNING id, name, key_prefix, created_at`,
    [req.user.id, name.trim(), prefix, hash]
  );

  // The full key is only ever returned here, at creation time.
  res.status(201).json({ key: { ...rows[0], full_key: full } });
});

// DELETE /api/keys/:id — revoke a key (owner only)
router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE api_keys SET revoked = TRUE, revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked = FALSE RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Key not found' });
  res.json({ revoked: true });
});

module.exports = router;
