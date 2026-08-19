const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin); // every route below is admin-only

const PLAN_LENGTH = { '3mo': 3, annual: 12 }; // months

// ---------- STATS ----------
router.get('/stats', async (req, res) => {
  const [today, month, year, revenue] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE created_at >= date_trunc('day', now())`),
    pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE created_at >= date_trunc('month', now())`),
    pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE created_at >= date_trunc('year', now())`),
    pool.query(`SELECT COALESCE(SUM(amount_usd),0) AS total FROM payments WHERE status='completed'`),
  ]);
  res.json({
    usersToday: today.rows[0].n,
    usersThisMonth: month.rows[0].n,
    usersThisYear: year.rows[0].n,
    totalRevenue: revenue.rows[0].total,
  });
});

// New users per day, for the last N days (default 14) — powers the overview chart
router.get('/stats/signups', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 14, 90);
  const { rows } = await pool.query(
    `SELECT date_trunc('day', created_at) AS day, COUNT(*)::int AS n
     FROM users WHERE created_at >= now() - ($1 || ' days')::interval
     GROUP BY day ORDER BY day`,
    [days]
  );
  res.json({ signups: rows });
});

// ---------- PAYMENTS ----------
router.get('/payments', async (req, res) => {
  const { status } = req.query; // 'pending' | 'completed' | undefined (all)
  const params = [];
  let where = '';
  if (status) { params.push(status); where = 'WHERE p.status = $1'; }
  const { rows } = await pool.query(
    `SELECT p.id, u.email, p.plan, p.amount_usd, p.method, p.status, p.tx_reference, p.created_at
     FROM payments p JOIN users u ON u.id = p.user_id
     ${where} ORDER BY p.created_at DESC LIMIT 200`,
    params
  );
  res.json({ payments: rows });
});

// Confirm a pending payment: marks it completed and extends/activates the user's plan.
router.post('/payments/:id/confirm', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM payments WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [req.params.id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pending payment not found' }); }
    const payment = rows[0];

    await client.query(
      `UPDATE payments SET status='completed', confirmed_by=$1, confirmed_at=now() WHERE id=$2`,
      [req.user.id, payment.id]
    );

    if (payment.plan === 'perm') {
      await client.query(`UPDATE users SET plan='perm', plan_expires_at=NULL WHERE id=$1`, [payment.user_id]);
    } else {
      const months = PLAN_LENGTH[payment.plan];
      await client.query(
        `UPDATE users SET plan=$1,
           plan_expires_at = GREATEST(COALESCE(plan_expires_at, now()), now()) + ($2 || ' months')::interval
         WHERE id=$3`,
        [payment.plan, months, payment.user_id]
      );
    }

    await client.query('COMMIT');
    res.json({ confirmed: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to confirm payment' });
  } finally {
    client.release();
  }
});

router.post('/payments/:id/reject', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE payments SET status='rejected' WHERE id=$1 AND status='pending' RETURNING id`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Pending payment not found' });
  res.json({ rejected: true });
});

// ---------- USERS ----------
router.get('/users', async (req, res) => {
  const search = `%${req.query.q || ''}%`;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.plan, u.status, u.created_at,
       (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id AND k.revoked = FALSE) AS active_keys
     FROM users u WHERE u.email ILIKE $1
     ORDER BY u.created_at DESC LIMIT 200`,
    [search]
  );
  res.json({ users: rows });
});

router.post('/users/:id/suspend', async (req, res) => {
  await pool.query(`UPDATE users SET status='suspended' WHERE id=$1`, [req.params.id]);
  res.json({ suspended: true });
});

router.post('/users/:id/unsuspend', async (req, res) => {
  await pool.query(`UPDATE users SET status='active' WHERE id=$1`, [req.params.id]);
  res.json({ unsuspended: true });
});

// ---------- API KEYS (admin can revoke ANY user's key) ----------
router.get('/keys', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT k.id, k.name, k.key_prefix, k.revoked, k.created_at, u.email AS owner_email
     FROM api_keys k JOIN users u ON u.id = k.user_id
     ORDER BY k.created_at DESC LIMIT 300`
  );
  res.json({ keys: rows });
});

router.post('/keys/:id/revoke', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE api_keys SET revoked=TRUE, revoked_at=now() WHERE id=$1 AND revoked=FALSE RETURNING id`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Key not found or already revoked' });
  res.json({ revoked: true });
});

// ---------- REPORTS ----------
router.get('/reports', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, u.email, r.subject, r.message, r.status, r.created_at
     FROM reports r JOIN users u ON u.id = r.user_id
     ORDER BY r.created_at DESC LIMIT 200`
  );
  res.json({ reports: rows });
});

router.post('/reports/:id/resolve', async (req, res) => {
  await pool.query(`UPDATE reports SET status='resolved', resolved_at=now() WHERE id=$1`, [req.params.id]);
  res.json({ resolved: true });
});

module.exports = router;
