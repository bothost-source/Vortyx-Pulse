// ---------------------------------------------------------------------------
// Real web search, using Google's Custom Search JSON API.
//
// SETUP (one-time):
// 1. Go to console.cloud.google.com -> create/select a project
// 2. APIs & Services -> Library -> enable "Custom Search API"
// 3. APIs & Services -> Credentials -> Create API key -> this is GOOGLE_SEARCH_API_KEY
// 4. Go to programmablesearchengine.google.com -> Add -> "Search the entire web"
// 5. Copy the Search engine ID -> this is GOOGLE_SEARCH_CSE_ID
// 6. Set both as environment variables on Render
//
// Free tier: 100 queries/day. After that Google returns a 429, which this
// module handles gracefully (falls back to "no search results" rather than
// crashing the whole chat request).
// ---------------------------------------------------------------------------

async function googleSearch(query, numResults = 5) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cseId = process.env.GOOGLE_SEARCH_CSE_ID;
  if (!apiKey || !cseId) {
    return { results: [], error: 'Web search is not configured (missing GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_CSE_ID).' };
  }

  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&num=${numResults}&q=${encodeURIComponent(query)}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { results: [], error: `Search request failed (${r.status}): ${body.slice(0, 200)}` };
    }
    const data = await r.json();
    const results = (data.items || []).map(item => ({
      title: item.title,
      snippet: item.snippet,
      link: item.link,
      source: (() => { try { return new URL(item.link).hostname; } catch { return item.link; } })(),
    }));
    return { results, error: null };
  } catch (err) {
    return { results: [], error: err.message };
  }
}

// Builds the augmented prompt the model actually sees — the user's original
// question plus the live search results as grounding context. The model is
// told explicitly to use them and to fall back to its own knowledge if
// they're not relevant, rather than forcing an answer from irrelevant results.
function buildSearchAugmentedPrompt(userMessage, results) {
  if (!results.length) return userMessage;

  const formatted = results
    .map((r, i) => `${i + 1}. ${r.title} (${r.source})\n${r.snippet}`)
    .join('\n\n');

  return `Use the following live web search results to help answer the question if they're relevant. If they aren't relevant, answer from your own knowledge instead. When you use a result, mention the source by name.

Search results:
${formatted}

Question: ${userMessage}`;
}

module.exports = { googleSearch, buildSearchAugmentedPrompt };
