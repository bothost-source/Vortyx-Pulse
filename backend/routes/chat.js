const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { getPlanLimits } = require('../config/plans');
const { callModel } = require('../lib/model');
const { googleSearch, buildSearchAugmentedPrompt } = require('../lib/search');

const router = express.Router();
router.use(requireAuth); // every route below requires a logged-in session

const SYSTEM_PROMPT = "You are Vortyx Pulse, created by LONER. Only mention your name or who made you if the user directly asks who you are, what you're called, or who created you. For every other message — greetings, small talk, questions, requests — respond naturally and directly without introducing yourself. You cannot attach, upload, or send real files, zip files, or images — you can only generate text. When asked to create a file or code, output the FULL content inside a triple-backtick code block with the language name after the backticks, and never say things like \"here's the file\" or \"I've attached it\" — just show the actual code content directly.";

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

    // Pull prior turns so the model actually has conversation memory —
    // previously only the latest message was ever sent, which is why it
    // seemed to forget everything after one reply.
    const priorRows = await pool.query(
      `SELECT role, content FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC LIMIT 40`,
      [convoId]
    );

    // Store the user's original message, unmodified — search results are
    // only used to build the prompt sent to the model, not saved as if
    // the user typed them.
    await pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2)`, [convoId, message]);

    let latestContent = message;
    let searchMeta = null;
    if (webSearch) {
      const { results, error } = await googleSearch(message);
      if (results.length) {
        latestContent = buildSearchAugmentedPrompt(message, results);
        searchMeta = { used: true, sources: results.map(r => ({ title: r.title, link: r.link, source: r.source })) };
      }
      // If search failed or returned nothing, silently fall through to a
      // normal model answer — no "search unavailable" text shown anywhere.
      // (error is only logged server-side, never sent to the client)
      if (error) console.error('web search failed:', error);
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...priorRows.rows.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: latestContent },
    ];

    const result = await callModel({ messages, maxTokens: req.body.longForm ? 1500 : 900 });
    const total = result.usage.input_tokens + result.usage.output_tokens;

    const [assistantMsg] = await Promise.all([
      pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1,'assistant',$2) RETURNING id`, [convoId, result.output]),
      pool.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [convoId]),
      pool.query(`UPDATE users SET tokens_used_this_period = tokens_used_this_period + $1 WHERE id = $2`, [total, req.user.id]),
      pool.query(
        `INSERT INTO request_logs (api_key_id, user_id, modality, source, input_tokens, output_tokens)
         VALUES (NULL,$1,'text','web',$2,$3)`,
        [req.user.id, result.usage.input_tokens, result.usage.output_tokens]
      ),
    ]);

    res.json({ conversationId: convoId, messageId: assistantMsg.rows[0].id, reply: result.output, usage: result.usage, search: searchMeta });
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
    `SELECT id, role, content, feedback, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC`,
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

// PATCH /api/chat/messages/:id/feedback — { feedback: 'up' | 'down' | null }
router.patch('/messages/:id/feedback', async (req, res) => {
  const { feedback } = req.body;
  if (feedback !== null && feedback !== 'up' && feedback !== 'down') {
    return res.status(422).json({ error: 'feedback must be "up", "down", or null' });
  }
  const { rows } = await pool.query(
    `UPDATE messages m SET feedback=$1
     FROM conversations c
     WHERE m.id=$2 AND m.conversation_id=c.id AND c.user_id=$3 AND m.role='assistant'
     RETURNING m.id`,
    [feedback, req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Message not found' });
  res.json({ updated: true });
});

// ---------------------------------------------------------------------------
// POST /api/chat/upload — multipart file upload. Accepts plain text/code
// files directly, and .zip archives (extracting readable text files inside,
// skipping binaries). Total size cap: 1MB. Returns the extracted text so the
// frontend can attach it as context for the next message — this is NOT
// stored on disk anywhere, it's processed in memory and discarded.
// ---------------------------------------------------------------------------
const multer = require('multer');
const AdmZip = require('adm-zip');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.go', '.rs', '.rb', '.php', '.html', '.css', '.json', '.yml', '.yaml', '.sql',
  '.sh', '.env', '.xml', '.csv', '.log',
]);

function isLikelyText(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(422).json({ error: 'No file uploaded' });
  const { originalname, buffer, mimetype } = req.file;

  try {
    if (originalname.toLowerCase().endsWith('.zip')) {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      let combined = '';
      let filesRead = 0;
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        if (!isLikelyText(entry.entryName)) continue;
        if (combined.length > 900000) break; // stay under ~1MB of extracted text
        const text = entry.getData().toString('utf8');
        combined += `\n\n--- ${entry.entryName} ---\n${text}`;
        filesRead++;
      }
      if (!filesRead) {
        return res.status(422).json({ error: 'No readable text/code files found in that zip.' });
      }
      return res.json({ filename: originalname, extractedText: combined.trim(), filesRead });
    }

    if (isLikelyText(originalname) || mimetype.startsWith('text/')) {
      return res.json({ filename: originalname, extractedText: buffer.toString('utf8'), filesRead: 1 });
    }

    return res.status(422).json({
      error: 'This file type isn\'t supported yet — Vortyx Pulse can read text and code files, and .zip archives of them. Image/PDF reading isn\'t available on this model yet.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not process that file', detail: err.message });
  }
});

module.exports = router;
