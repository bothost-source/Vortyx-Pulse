const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { getPlanLimits } = require('../config/plans');
const { callModel, estimateTokens } = require('../lib/model');
const { googleSearch, buildSearchAugmentedPrompt } = require('../lib/search');

const router = express.Router();

// ---------------------------------------------------------------------------
// This is the endpoint your USERS call (not your dashboard) — e.g.
//   POST https://api.vortyxpulse.com/v1/chat
//   Authorization: Bearer vp_live_xxxxxxxx
//
// Flow: authenticate by API key -> check plan expiry -> check rate limit
// -> check monthly token quota -> call the real model -> log usage.
// A request that fails any check never reaches the model.
// ---------------------------------------------------------------------------

async function authenticateApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const fullKey = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!fullKey) return res.status(401).json({ error: 'Missing API key' });

  const hash = crypto.createHash('sha256').update(fullKey).digest('hex');
  const { rows } = await pool.query(
    `SELECT k.id AS key_id, u.* FROM api_keys k
     JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1 AND k.revoked = FALSE`,
    [hash]
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid or revoked API key' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

  const expired =
    user.plan === 'free'
      ? new Date() > new Date(new Date(user.created_at).setDate(new Date(user.created_at).getDate() + 30))
      : user.plan !== 'perm' && user.plan_expires_at && new Date() > new Date(user.plan_expires_at);
  if (expired) return res.status(403).json({ error: 'Plan expired — upgrade to continue making requests' });

  req.vortyxUser = user;
  req.vortyxKeyId = user.key_id;
  next();
}

// ---------------------------------------------------------------------------
// Rate limiting: simple in-memory sliding window per user, keyed by user id.
// Resets if the server restarts — fine for a single-instance deployment.
// If you ever run multiple server instances, move this to Redis instead.
// ---------------------------------------------------------------------------
const requestLog = new Map(); // userId -> array of timestamps (ms)

function checkRateLimit(req, res, next) {
  const limits = getPlanLimits(req.vortyxUser.plan);
  const now = Date.now();
  const windowMs = 60 * 1000;

  const timestamps = (requestLog.get(req.vortyxUser.id) || []).filter(t => now - t < windowMs);
  if (timestamps.length >= limits.requestsPerMinute) {
    return res.status(429).json({
      error: `Rate limit exceeded — max ${limits.requestsPerMinute} requests per minute on your plan.`,
    });
  }
  timestamps.push(now);
  requestLog.set(req.vortyxUser.id, timestamps);
  next();
}

// ---------------------------------------------------------------------------
// Token quota: resets automatically once period_reset_at has passed.
// A user over quota gets rejected here — the request never reaches the model.
// ---------------------------------------------------------------------------
async function checkTokenQuota(req, res, next) {
  const limits = getPlanLimits(req.vortyxUser.plan);
  if (limits.monthlyTokens === null) return next(); // unlimited plan

  let { tokens_used_this_period, period_reset_at, id: userId } = req.vortyxUser;

  if (new Date() > new Date(period_reset_at)) {
    const { rows } = await pool.query(
      `UPDATE users SET tokens_used_this_period = 0, period_reset_at = now() + interval '30 days'
       WHERE id = $1 RETURNING tokens_used_this_period, period_reset_at`,
      [userId]
    );
    tokens_used_this_period = rows[0].tokens_used_this_period;
    req.vortyxUser.tokens_used_this_period = tokens_used_this_period;
  }

  if (tokens_used_this_period >= limits.monthlyTokens) {
    return res.status(429).json({
      error: `Monthly token quota exceeded (${limits.monthlyTokens} tokens on your plan). Upgrade for a higher limit, or wait for your quota to reset.`,
    });
  }
  next();
}

async function logUsage(req, modality, inputTokens = 0, outputTokens = 0) {
  const total = inputTokens + outputTokens;
  await Promise.all([
    pool.query(
      `INSERT INTO request_logs (api_key_id, user_id, modality, input_tokens, output_tokens)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.vortyxKeyId, req.vortyxUser.id, modality, inputTokens, outputTokens]
    ),
    pool.query(
      `UPDATE users SET tokens_used_this_period = tokens_used_this_period + $1 WHERE id = $2`,
      [total, req.vortyxUser.id]
    ),
  ]);
}

// (estimateTokens and callModel now live in lib/model.js, shared with routes/chat.js)

router.post('/chat', authenticateApiKey, checkRateLimit, checkTokenQuota, async (req, res) => {
  const { input, messages: priorMessages, modality = 'text', web_search, max_tokens } = req.body;
  if (!input) return res.status(422).json({ error: '"input" is required' });
  if (modality !== 'text') {
    return res.status(400).json({ error: `Modality "${modality}" is not available yet — only "text" is live right now.` });
  }

  try {
    let latestContent = input;
    let search = null;
    if (web_search) {
      const { results, error } = await googleSearch(input);
      if (results.length) {
        latestContent = buildSearchAugmentedPrompt(input, results);
        search = { used: true, sources: results.map(r => ({ title: r.title, link: r.link, source: r.source })) };
      }
      if (error) console.error('web search failed:', error);
    }

    // Optional: pass `messages` (array of {role, content}) for multi-turn
    // conversations via the API. Without it, this behaves as a single-turn
    // request like before.
    const conversation = [
      { role: 'system', content: "You are Vortyx Pulse, created by LONER. Only mention your name or who made you if the user directly asks who you are, what you're called, or who created you. For every other message, respond naturally and directly without introducing yourself." },
      ...(Array.isArray(priorMessages) ? priorMessages : []),
      { role: 'user', content: latestContent },
    ];

    const result = await callModel({ messages: conversation, maxTokens: Math.min(max_tokens || 900, 2000) });
    await logUsage(req, modality, result.usage.input_tokens, result.usage.output_tokens);
    res.json({ ...result, search });
  } catch (err) {
    res.status(502).json({ error: 'Model request failed', detail: err.message });
  }
});

router.post('/audio', authenticateApiKey, checkRateLimit, checkTokenQuota, async (req, res) => {
  res.status(400).json({ error: 'Audio modality is not available yet.' });
});

router.post('/video', authenticateApiKey, checkRateLimit, checkTokenQuota, async (req, res) => {
  res.status(400).json({ error: 'Video modality is not available yet.' });
});

module.exports = router;
