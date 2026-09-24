const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// PATCH /api/account/me — { name }
router.patch('/me', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(422).json({ error: 'Name cannot be empty' });
  const { rows } = await pool.query(
    `UPDATE users SET name=$1 WHERE id=$2 RETURNING id, email, name, avatar_url, plan`,
    [name.trim().slice(0, 80), req.user.id]
  );
  res.json({ user: rows[0] });
});

// DELETE /api/account/me — permanently deletes the account and everything
// tied to it (API keys, payments, reports, conversations) via ON DELETE
// CASCADE in the schema. This cannot be undone.
router.delete('/me', async (req, res) => {
  await pool.query(`DELETE FROM users WHERE id=$1`, [req.user.id]);
  res.json({ deleted: true });
});

module.exports = router;
