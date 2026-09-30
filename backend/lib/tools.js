const pool = require('../db/pool');
const { googleSearch } = require('./search');

// ---------------------------------------------------------------------------
// TOOL: web_search — real Google Custom Search results (see lib/search.js).
// ---------------------------------------------------------------------------
async function toolWebSearch(args) {
  const query = (args?.query || '').trim();
  if (!query) return { error: 'query is required' };
  const { results, error } = await googleSearch(query);
  if (error && !results.length) return { error };
  return { results: results.map(r => ({ title: r.title, snippet: r.snippet, source: r.source, link: r.link })) };
}

// ---------------------------------------------------------------------------
// TOOL: calculator — a real deterministic evaluator, not the model guessing
// at arithmetic. Whitelist-only: digits, ()+-*/. and spaces — nothing else
// is ever passed to the evaluator, so it can't execute arbitrary code.
// ---------------------------------------------------------------------------
function toolCalculate(args, userId) {
  const expr = (args?.expression || '').trim();
  if (!expr) return { error: 'expression is required' };
  if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
    return { error: 'expression contains characters that are not allowed (only numbers and + - * / ( ) are supported)' };
  }
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${expr});`)();
    if (typeof result !== 'number' || !isFinite(result)) return { error: 'Could not evaluate that expression' };
    return { result };
  } catch (e) {
    return { error: 'Could not evaluate that expression' };
  }
}

// ---------------------------------------------------------------------------
// TOOL: remember / recall — real persistent storage in Postgres, scoped to
// the logged-in user, visible and deletable by them in Settings.
// ---------------------------------------------------------------------------
async function toolRemember(args, userId) {
  const content = (args?.fact || '').trim().slice(0, 500);
  if (!content) return { error: 'fact is required' };
  await pool.query(`INSERT INTO user_memories (user_id, content) VALUES ($1,$2)`, [userId, content]);
  return { saved: true, fact: content };
}

async function getUserMemories(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, content, created_at FROM user_memories WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Executes a tool call by name. Returns a plain object result (never throws
// — errors come back as { error: "..." } so the model can react to them).
// ---------------------------------------------------------------------------
async function executeTool(name, args, userId) {
  switch (name) {
    case 'web_search': return toolWebSearch(args);
    case 'calculate': return toolCalculate(args, userId);
    case 'remember': return toolRemember(args, userId);
    default: return { error: `Unknown tool "${name}"` };
  }
}

const TOOLS_DESCRIPTION = `You have real tools you can call. To use one, output ONLY this on its own, with nothing else in the message:
<tool_call>{"name": "TOOL_NAME", "arguments": { ... }}</tool_call>

Available tools:
- web_search: { "query": "search text" } — use for anything current, recent, or that you're not confident about.
- calculate: { "expression": "12 * (5 + 3)" } — use for any arithmetic instead of computing it yourself.
- remember: { "fact": "short fact about the user or their project" } — use when the user tells you something worth remembering for later (a preference, their name, an ongoing project detail).

Only call a tool when you actually need it. For normal questions, just answer directly — don't call a tool unnecessarily.`;

module.exports = { executeTool, getUserMemories, TOOLS_DESCRIPTION };
