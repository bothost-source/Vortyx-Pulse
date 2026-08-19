const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/reports — user submits an issue
router.post('/', requireAuth, async (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !message) return res.status(422).json({ error: 'Subject and message are required' });
  const { rows } = await pool.query(
    `INSERT INTO reports (user_id, subject, message) VALUES ($1,$2,$3) RETURNING id, created_at`,
    [req.user.id, subject.trim(), message.trim()]
  );
  res.status(201).json({ report: rows[0] });
});

// GET /api/reports/mine — the caller's own reports
router.get('/mine', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, subject, status, created_at, resolved_at FROM reports WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ reports: rows });
});

module.exports = router;
