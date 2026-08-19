const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');

const router = express.Router();

// ---------------------------------------------------------------------------
// This is the endpoint your USERS call (not your dashboard) — e.g.
//   POST https://api.vortyxpulse.com/v1/chat
//   Authorization: Bearer vp_live_xxxxxxxx
//
// It authenticates by API key (not by login session), checks the owning
// user's plan/expiry, then forwards the request to your actual model.
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

  // Plan expiry check
  const expired =
    user.plan === 'free'
      ? new Date() > new Date(new Date(user.created_at).setDate(new Date(user.created_at).getDate() + 30))
      : user.plan !== 'perm' && user.plan_expires_at && new Date() > new Date(user.plan_expires_at);
  if (expired) return res.status(403).json({ error: 'Plan expired — upgrade to continue making requests' });

  req.vortyxUser = user;
  req.vortyxKeyId = user.key_id;
  next();
}

async function logUsage(req, modality, inputTokens = 0, outputTokens = 0) {
  await pool.query(
    `INSERT INTO request_logs (api_key_id, user_id, modality, input_tokens, output_tokens)
     VALUES ($1,$2,$3,$4,$5)`,
    [req.vortyxKeyId, req.vortyxUser.id, modality, inputTokens, outputTokens]
  );
}

// ---------------------------------------------------------------------------
// callModel() is the ONE function to replace once your model is ready.
// Point it at your own inference server, or at a third-party provider
// (Gemini, etc.) if vortyx-1 is itself built as a routed wrapper.
// ---------------------------------------------------------------------------
async function callModel({ modality, input, stream }) {
  // TODO: replace with a real call, e.g.:
  //   const r = await fetch(process.env.MODEL_ENDPOINT, {
  //     method: 'POST',
  //     headers: { 'Authorization': `Bearer ${process.env.MODEL_API_KEY}` },
  //     body: JSON.stringify({ modality, input }),
  //   });
  //   return await r.json();
  return {
    id: 'resp_' + crypto.randomBytes(6).toString('hex'),
    model: 'vortyx-1',
    output: `[stub response] You said: "${input}"`,
    usage: { input_tokens: Math.ceil((input || '').length / 4), output_tokens: 12 },
  };
}

router.post('/chat', authenticateApiKey, async (req, res) => {
  const { input, modality = 'text', stream } = req.body;
  if (!input) return res.status(422).json({ error: '"input" is required' });

  const result = await callModel({ modality, input, stream });
  await logUsage(req, modality, result.usage.input_tokens, result.usage.output_tokens);
  res.json(result);
});

router.post('/audio', authenticateApiKey, async (req, res) => {
  // Real implementation: use multer or busboy to accept multipart audio upload.
  const result = await callModel({ modality: 'audio', input: '[audio upload]' });
  await logUsage(req, 'audio', 0, result.usage.output_tokens);
  res.json(result);
});

router.post('/video', authenticateApiKey, async (req, res) => {
  const result = await callModel({ modality: 'video', input: '[video upload]' });
  await logUsage(req, 'video', 0, result.usage.output_tokens);
  res.json(result);
});

module.exports = router;
