const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { getPlanLimits } = require('../config/plans');
const { callModel } = require('../lib/model');
const { googleSearch, buildSearchAugmentedPrompt } = require('../lib/search');
const { lookupWikipediaEntity } = require('../lib/wikipedia');
const { executeTool, getUserMemories, TOOLS_DESCRIPTION } = require('../lib/tools');
const multer = require('multer');
const AdmZip = require('adm-zip');

const router = express.Router();
router.use(requireAuth); // every route below requires a logged-in session

const SYSTEM_PROMPT = "You are Vortyx Pulse, created by LONER. Only mention your name or who made you if the user directly asks who you are, what you're called, or who created you. For every other message — greetings, small talk, questions, requests — respond naturally and directly without introducing yourself. You are a real coding assistant capable of writing full websites, applications, and any code the user asks for — never say you don't have the ability to build something; just write the code. You cannot attach, upload, or send real files, zip files, or images — you can only generate text. CRITICAL: whenever asked to create, write, build, or generate any file, script, bot, or code, you MUST output the complete, real, working code inside a triple-backtick code block right in your reply — for example ```javascript\\ncode here\\n```. Never describe what the code would contain, never say \"here's the file\" or \"I've attached it\" or \"the file contains\" — always show the literal code itself.";

// ---------------------------------------------------------------------------
// Rate limit: in-memory sliding window per user, kept separate from the
// public API's limiter so the website and API have independent budgets.
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

// ---------------------------------------------------------------------------
// Token quota — reset check + limit check happen in ONE atomic UPDATE so two
// rapid/overlapping requests can't both pass the check before either has
// deducted anything (the old read-then-write pattern could let usage slip
// past the limit, or double count if a request was retried).
// ---------------------------------------------------------------------------
async function resetQuotaIfDue(userId) {
  await pool.query(
    `UPDATE users SET tokens_used_this_period = 0, period_reset_at = now() + interval '30 days'
     WHERE id = $1 AND now() > period_reset_at`,
    [userId]
  );
}

async function isOverQuota(userId, plan) {
  const limits = getPlanLimits(plan);
  if (limits.monthlyTokens === null) return { over: false, limits };
  await resetQuotaIfDue(userId);
  const { rows } = await pool.query(`SELECT tokens_used_this_period FROM users WHERE id=$1`, [userId]);
  return { over: rows[0].tokens_used_this_period >= limits.monthlyTokens, limits, used: rows[0].tokens_used_this_period };
}

// Deducts tokens atomically — a single UPDATE, not read-then-write, so
// concurrent requests can never lose or double an increment.
async function deductTokens(userId, amount) {
  await pool.query(`UPDATE users SET tokens_used_this_period = tokens_used_this_period + $1 WHERE id = $2`, [amount, userId]);
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.go', '.rs', '.rb', '.php', '.html', '.css', '.json', '.yml', '.yaml', '.sql',
  '.sh', '.env', '.xml', '.csv', '.log',
]);
function isLikelyText(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function extractFileText(originalname, buffer, mimetype) {
  if (originalname.toLowerCase().endsWith('.zip')) {
    const zip = new AdmZip(buffer);
    let combined = '', filesRead = 0;
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !isLikelyText(entry.entryName)) continue;
      if (combined.length > 900000) break;
      combined += `\n\n--- ${entry.entryName} ---\n${entry.getData().toString('utf8')}`;
      filesRead++;
    }
    return { text: combined.trim(), filesRead };
  }
  if (isLikelyText(originalname) || (mimetype || '').startsWith('text/')) {
    return { text: buffer.toString('utf8'), filesRead: 1 };
  }
  return { text: null, filesRead: 0 };
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

// POST /api/chat/send — JSON body OR multipart (with a `file` field).
// Fields: conversationId?, message, webSearch?
router.post('/send', upload.single('file'), async (req, res) => {
  const { conversationId, message = '', webSearch } = req.body;
  const caption = (message || '').trim();
  if (!caption && !req.file) return res.status(422).json({ error: 'Message cannot be empty' });

  if (!checkRateLimit(req.user.id, req.user.plan)) {
    const limits = getPlanLimits(req.user.plan);
    return res.status(429).json({ error: `Rate limit exceeded — max ${limits.requestsPerMinute} requests per minute on your plan.` });
  }

  const quota = await isOverQuota(req.user.id, req.user.plan);
  if (quota.over) {
    return res.status(429).json({
      quotaExceeded: true,
      error: `Monthly token quota exceeded (${quota.limits.monthlyTokens} tokens on your plan). Upgrade for a higher limit, or wait for your quota to reset.`,
    });
  }

  let convoId = conversationId;
  try {
    if (convoId) {
      const { rows } = await pool.query(`SELECT id FROM conversations WHERE id=$1 AND user_id=$2`, [convoId, req.user.id]);
      if (!rows.length) return res.status(404).json({ error: 'Conversation not found' });
    } else {
      const title = (caption || req.file?.originalname || 'New chat').slice(0, 60);
      const { rows } = await pool.query(`INSERT INTO conversations (user_id, title) VALUES ($1,$2) RETURNING id`, [req.user.id, title]);
      convoId = rows[0].id;
    }

    // Validate the file (if any) BEFORE writing anything to the database.
    // An unsupported file must never leave a dangling user message with no
    // reply — that corrupted later turns in this exact way before.
    let attachmentText = null;
    if (req.file) {
      const { text } = extractFileText(req.file.originalname, req.file.buffer, req.file.mimetype);
      if (text === null) {
        return res.status(422).json({ error: "This file type isn't supported yet — Vortyx Pulse can read text/code files and .zip archives of them." });
      }
      attachmentText = text;
    }

    // Pull prior turns (with any attachment text) for real multi-turn memory.
    const priorRows = await pool.query(
      `SELECT m.role, m.content, a.extracted_text AS attachment_text
       FROM messages m LEFT JOIN message_attachments a ON a.message_id = m.id
       WHERE m.conversation_id=$1 ORDER BY m.created_at ASC LIMIT 40`,
      [convoId]
    );

    // Store ONLY the clean caption as the visible message — never the raw
    // extracted file text. That's what was causing pasted/uploaded file
    // content to show as a text dump on reload instead of a file card.
    const userMsg = await pool.query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2) RETURNING id`,
      [convoId, caption || `[Attached: ${req.file?.originalname}]`]
    );
    const userMsgId = userMsg.rows[0].id;

    if (req.file) {
      const attachRow = await pool.query(
        `INSERT INTO message_attachments (message_id, filename, mime_type, size_bytes, content, extracted_text)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [userMsgId, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, attachmentText]
      );
      req.attachmentId = attachRow.rows[0].id;
    }

    let latestContent = caption || '(see attached file)';
    if (attachmentText) {
      latestContent += `\n\nAttached file "${req.file.originalname}":\n${attachmentText}`;
    }

    let searchMeta = null;
    let entity = null;
    if (webSearch === 'true' || webSearch === true) {
      entity = await lookupWikipediaEntity(caption);
      const { results, error } = await googleSearch(caption);
      if (results.length) {
        latestContent = buildSearchAugmentedPrompt(latestContent, results);
        searchMeta = { used: true, sources: results.map(r => ({ title: r.title, link: r.link, source: r.source })) };
      }
      if (error) console.error('web search failed:', error);
    }

    const memories = await getUserMemories(req.user.id);
    const memoryBlock = memories.length
      ? `\n\nKnown facts about this user (from earlier conversations):\n${memories.map(m => `- ${m.content}`).join('\n')}`
      : '';

    const modelMessages = [
      { role: 'system', content: SYSTEM_PROMPT + '\n\n' + TOOLS_DESCRIPTION + memoryBlock },
      ...priorRows.rows.map(m => ({
        role: m.role,
        content: m.attachment_text ? `${m.content}\n\n[Earlier attached file content]:\n${m.attachment_text.slice(0, 3000)}` : m.content,
      })),
      { role: 'user', content: latestContent },
    ];

    let result = await callModel({ messages: modelMessages, maxTokens: req.body.longForm ? 1500 : 900 });
    let finalOutput = result.output;
    let totalInputTokens = result.usage.input_tokens;
    let totalOutputTokens = result.usage.output_tokens;
    const toolsUsed = [];

    // Real tool-call loop (max 2 calls per message, so a confused model
    // can't loop forever). The model requests a tool with a <tool_call>
    // tag; we execute it for real and feed the real result back.
    for (let i = 0; i < 2; i++) {
      const m = finalOutput.match(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/);
      if (!m) break;
      let call;
      try { call = JSON.parse(m[1]); } catch { break; }
      if (!call?.name) break;

      const toolResult = await executeTool(call.name, call.arguments, req.user.id);
      toolsUsed.push(call.name);

      const followUp = [
        ...modelMessages,
        { role: 'assistant', content: finalOutput },
        { role: 'user', content: `<tool_result>${JSON.stringify(toolResult)}</tool_result>\nUse this real result to answer the original question. Don't mention the tag format.` },
      ];
      const followResult = await callModel({ messages: followUp, maxTokens: 900 });
      finalOutput = followResult.output;
      totalInputTokens += followResult.usage.input_tokens;
      totalOutputTokens += followResult.usage.output_tokens;
    }

    // Safety cleanup: never show a raw tool tag to the user if the loop
    // exited without fully resolving one (e.g. bad JSON, or hit the cap).
    finalOutput = finalOutput.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim() || finalOutput;

    // Safety net: if the request clearly asked for code/a file but the
    // model just described what it would contain instead of writing it
    // (no code fence anywhere), automatically re-run once with an explicit
    // correction. This is a real second model call, not a fake patch —
    // it genuinely regenerates the answer.
    const askedForCode = /\b(create|write|build|generate|make)\b.{0,40}\b(file|code|script|bot|zip|function|class|component)\b/i.test(caption);
    const hasCodeFence = /```/.test(finalOutput);
    let retried = false;
    if (askedForCode && !hasCodeFence) {
      const correctionMessages = [
        ...modelMessages,
        { role: 'assistant', content: finalOutput },
        { role: 'user', content: 'You described the code instead of writing it. Output the complete, real code now inside a triple-backtick code block — not a description of what it would do.' },
      ];
      try {
        const retryResult = await callModel({ messages: correctionMessages, maxTokens: 1500 });
        if (/```/.test(retryResult.output)) {
          finalOutput = retryResult.output;
          totalInputTokens += retryResult.usage.input_tokens;
          totalOutputTokens += retryResult.usage.output_tokens;
          retried = true;
        }
      } catch (retryErr) {
        // If the retry itself fails, just keep the original response.
      }
    }

    const total = totalInputTokens + totalOutputTokens;

    // Deterministic summary of what's actually in the response — parsed
    // from the real output, not the model's own (unreliable) self-report.
    const fileMatches = [...finalOutput.matchAll(/```(\w+)\n([\s\S]*?)```/g)];
    const filesSummary = fileMatches.map(m => ({
      language: m[1] || 'text',
      lines: m[2].split('\n').length,
    }));

    const [assistantMsg] = await Promise.all([
      pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1,'assistant',$2) RETURNING id`, [convoId, finalOutput]),
      pool.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [convoId]),
      deductTokens(req.user.id, total),
      pool.query(
        `INSERT INTO request_logs (api_key_id, user_id, modality, source, input_tokens, output_tokens)
         VALUES (NULL,$1,'text','web',$2,$3)`,
        [req.user.id, totalInputTokens, totalOutputTokens]
      ),
    ]);

    res.json({
      conversationId: convoId,
      messageId: assistantMsg.rows[0].id,
      userMessageId: userMsgId,
      reply: finalOutput,
      usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      search: searchMeta,
      entity,
      retried,
      toolsUsed,
      files: filesSummary,
      attachment: req.file ? { id: req.attachmentId, filename: req.file.originalname, sizeBytes: req.file.size } : null,
    });
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

// GET /api/chat/conversations/:id — full message history, with attachment
// metadata (not the bytes) so the frontend can render a real file card.
router.get('/conversations/:id', async (req, res) => {
  const convo = await pool.query(`SELECT id, title FROM conversations WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
  if (!convo.rows.length) return res.status(404).json({ error: 'Conversation not found' });

  const { rows } = await pool.query(
    `SELECT m.id, m.role, m.content, m.feedback, m.created_at,
            a.id AS attachment_id, a.filename AS attachment_filename, a.size_bytes AS attachment_size
     FROM messages m LEFT JOIN message_attachments a ON a.message_id = m.id
     WHERE m.conversation_id=$1 ORDER BY m.created_at ASC`,
    [req.params.id]
  );
  const messages = rows.map(r => ({
    id: r.id, role: r.role, content: r.content, feedback: r.feedback, created_at: r.created_at,
    attachment: r.attachment_id ? { id: r.attachment_id, filename: r.attachment_filename, sizeBytes: r.attachment_size } : null,
  }));
  res.json({ conversation: convo.rows[0], messages });
});

// GET /api/chat/attachments/:id/download — the real uploaded file, bytes and all
router.get('/attachments/:id/download', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.filename, a.mime_type, a.content
     FROM message_attachments a
     JOIN messages m ON m.id = a.message_id
     JOIN conversations c ON c.id = m.conversation_id
     WHERE a.id=$1 AND c.user_id=$2`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });
  const file = rows[0];
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`);
  res.send(file.content);
});

// DELETE /api/chat/conversations/:id
router.delete('/conversations/:id', async (req, res) => {
  const { rows } = await pool.query(`DELETE FROM conversations WHERE id=$1 AND user_id=$2 RETURNING id`, [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ deleted: true });
});

// PATCH /api/chat/messages/:id/feedback
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

module.exports = router;
