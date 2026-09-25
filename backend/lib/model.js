const crypto = require('crypto');

// Rough token estimate (chars / 4) — good enough for quota tracking without
// pulling in a full tokenizer. The HF Space doesn't return token counts.
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// Talks to your deployed Hugging Face Space.
//   MODEL_ENDPOINT = https://your-space-url/v1/chat/completions
//   MODEL_API_KEY   = the INTERNAL_SECRET you set as a Space secret
// `messages` is the FULL conversation so far (system + prior turns +
// latest turn) — the Space itself builds the Qwen chat-format prompt
// from this array, so passing the whole history here is what gives the
// model real multi-turn memory instead of only seeing the latest message.
async function callModel({ messages, maxTokens = 900 }) {
  if (!process.env.MODEL_ENDPOINT || !process.env.MODEL_API_KEY) {
    throw new Error('Model is not configured yet — set MODEL_ENDPOINT and MODEL_API_KEY in the backend .env');
  }

  const r = await fetch(process.env.MODEL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': process.env.MODEL_API_KEY,
    },
    body: JSON.stringify({ messages, max_tokens: maxTokens }),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Model request failed (${r.status}): ${errText.slice(0, 300)}`);
  }

  const data = await r.json();
  const outputText = data.choices?.[0]?.message?.content || '';
  const inputText = messages.map(m => m.content).join(' ');

  return {
    id: data.id || ('resp_' + crypto.randomBytes(6).toString('hex')),
    model: 'vortyx-1',
    output: outputText,
    usage: {
      input_tokens: estimateTokens(inputText),
      output_tokens: estimateTokens(outputText),
    },
  };
}

module.exports = { callModel, estimateTokens };
