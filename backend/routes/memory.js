const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/memory — everything Vortyx Pulse has stored about this user
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, content, created_at FROM user_memories WHERE user_id=$1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ memories: rows });
});

// DELETE /api/memory/:id — remove one fact
router.delete('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM user_memories WHERE id=$1 AND user_id=$2 RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Memory not found' });
  res.json({ deleted: true });
});

// DELETE /api/memory — clear everything
router.delete('/', async (req, res) => {
  await pool.query(`DELETE FROM user_memories WHERE user_id=$1`, [req.user.id]);
  res.json({ deleted: true });
});

module.exports = router;
