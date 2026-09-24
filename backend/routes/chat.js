const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { getPlanLimits } = require('../config/plans');
const { callModel } = require('../lib/model');
const { googleSearch, buildSearchAugmentedPrompt } = require('../lib/search');

const router = express.Router();
router.use(requireAuth); // every route below requires a logged-in session

// ---------------------------------------------------------------------------
// Same protections as the public /v1/chat API: rate limit + monthly token
// quota, checked before the model is ever called. Kept as its own small
// in-memory map (keyed by user id) rather than sharing v1.js's map, so a
// user hammering the website doesn't eat into their own API rate limit
// and vice versa — they're separate surfaces with separate budgets.
// ---------------------------------------------------------------------------
const requestLog = new Map();

function checkRateLimit(userId, plan) {
  const limits = getPlanLimits(plan);
  const now = Date.now();
  const windowMs = 60 * 1000;
  const timestamps = (requestLog.get(userId) || []).filter(t => now - t < windowMs);
  if (timestamps.length >= limits.requestsPerMinute) return false;
  timestamps.push(now);
  requestLog.set(userId, timestamps);
  return true;
}

async function checkAndGetQuota(user) {
  const limits = getPlanLimits(user.plan);
  if (limits.monthlyTokens === null) return { ok: true, limits };

  let { tokens_used_this_period, period_reset_at, id: userId } = user;
  if (new Date() > new Date(period_reset_at)) {
    const { rows } = await pool.query(
      `UPDATE users SET tokens_used_this_period = 0, period_reset_at = now() + interval '30 days'
       WHERE id = $1 RETURNING tokens_used_this_period`,
      [userId]
    );
    tokens_used_this_period = rows[0].tokens_used_this_period;
  }
  return { ok: tokens_used_this_period < limits.monthlyTokens, limits };
}

// POST /api/chat/send — { conversationId?, message, webSearch? }
// Creates a new conversation if conversationId is omitted.
router.post('/send', async (req, res) => {
  const { conversationId, message, webSearch } = req.body;
  if (!message || !message.trim()) return res.status(422).json({ error: 'Message cannot be empty' });

  if (!checkRateLimit(req.user.id, req.user.plan)) {
    const limits = getPlanLimits(req.user.plan);
    return res.status(429).json({ error: `Rate limit exceeded — max ${limits.requestsPerMinute} requests per minute on your plan.` });
  }

  const quota = await checkAndGetQuota(req.user);
  if (!quota.ok) {
    return res.status(429).json({
      error: `Monthly token quota exceeded (${quota.limits.monthlyTokens} tokens on your plan). Upgrade for a higher limit, or wait for your quota to reset.`,
    });
  }

  let convoId = conversationId;
  try {
    if (convoId) {
      const { rows } = await pool.query(`SELECT id FROM conversations WHERE id=$1 AND user_id=$2`, [convoId, req.user.id]);
      if (!rows.length) return res.status(404).json({ error: 'Conversation not found' });
    } else {
      const title = message.trim().slice(0, 60);
      const { rows } = await pool.query(
        `INSERT INTO conversations (user_id, title) VALUES ($1,$2) RETURNING id`,
        [req.user.id, title]
      );
      convoId = rows[0].id;
    }

    // Store the user's original message, unmodified — search results are
    // only used to build the prompt sent to the model, not saved as if
    // the user typed them.
    await pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2)`, [convoId, message]);

    let modelInput = message;
    let searchMeta = null;
    if (webSearch) {
      const { results, error } = await googleSearch(message);
      if (error && !results.length) {
        searchMeta = { used: false, error };
      } else {
        modelInput = buildSearchAugmentedPrompt(message, results);
        searchMeta = { used: results.length > 0, sources: results.map(r => ({ title: r.title, link: r.link, source: r.source })) };
      }
    }

    const result = await callModel({ input: modelInput });
    const total = result.usage.input_tokens + result.usage.output_tokens;

    await Promise.all([
      pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1,'assistant',$2)`, [convoId, result.output]),
      pool.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [convoId]),
      pool.query(`UPDATE users SET tokens_used_this_period = tokens_used_this_period + $1 WHERE id = $2`, [total, req.user.id]),
      pool.query(
        `INSERT INTO request_logs (api_key_id, user_id, modality, source, input_tokens, output_tokens)
         VALUES (NULL,$1,'text','web',$2,$3)`,
        [req.user.id, result.usage.input_tokens, result.usage.output_tokens]
      ),
    ]);

    res.json({ conversationId: convoId, reply: result.output, usage: result.usage, search: searchMeta });
  } catch (err) {
    res.status(502).json({ error: 'Model request failed', detail: err.message });
  }
});

// GET /api/chat/conversations — list, newest first
router.get('/conversations', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, created_at, updated_at FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC`,
    [req.user.id]
  );
  res.json({ conversations: rows });
});

// GET /api/chat/conversations/:id — full message history for one conversation
router.get('/conversations/:id', async (req, res) => {
  const convo = await pool.query(`SELECT id, title FROM conversations WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
  if (!convo.rows.length) return res.status(404).json({ error: 'Conversation not found' });

  const { rows } = await pool.query(
    `SELECT role, content, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC`,
    [req.params.id]
  );
  res.json({ conversation: convo.rows[0], messages: rows });
});

// DELETE /api/chat/conversations/:id
router.delete('/conversations/:id', async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM conversations WHERE id=$1 AND user_id=$2 RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ deleted: true });
});

module.exports = router;
