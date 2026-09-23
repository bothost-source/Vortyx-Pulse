const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { getPlanLimits } = require('../config/plans');

const router = express.Router();

// GET /api/usage/mine — real per-modality totals + last 14 days for the chart,
// plus the caller's current token quota status.
// Returns zeros/empty arrays for a brand new account, never fake numbers.
router.get('/mine', requireAuth, async (req, res) => {
  const [totals, daily] = await Promise.all([
    pool.query(
      `SELECT modality, COUNT(*)::int AS requests,
              COALESCE(SUM(input_tokens),0)::int AS input_tokens,
              COALESCE(SUM(output_tokens),0)::int AS output_tokens
       FROM request_logs WHERE user_id = $1 GROUP BY modality`,
      [req.user.id]
    ),
    pool.query(
      `SELECT date_trunc('day', created_at) AS day, COUNT(*)::int AS requests
       FROM request_logs WHERE user_id = $1 AND created_at >= now() - interval '14 days'
       GROUP BY day ORDER BY day`,
      [req.user.id]
    ),
  ]);

  const byModality = { text: 0, audio: 0, video: 0 };
  totals.rows.forEach(r => { byModality[r.modality] = r.requests; });

  const limits = getPlanLimits(req.user.plan);
  const quota = {
    used: req.user.tokens_used_this_period,
    limit: limits.monthlyTokens, // null = unlimited
    resetsAt: req.user.period_reset_at,
    requestsPerMinute: limits.requestsPerMinute,
  };

  res.json({ byModality, daily: daily.rows, quota });
});

module.exports = router;
