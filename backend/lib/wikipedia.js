// Free, no-key-required Wikipedia REST API — used to build a structured
// "entity card" (name, short description, summary, source link) for
// factual lookups like "who is X" / "what is X", instead of only a plain
// text answer. This is real data from Wikipedia, not invented.

const ENTITY_PATTERN = /^\s*(who|what)\s+(is|was|are|were)\s+(.+?)\??\s*$/i;

function extractEntityQuery(message) {
  const m = message.match(ENTITY_PATTERN);
  return m ? m[3].trim() : null;
}

async function lookupWikipediaEntity(message) {
  const query = extractEntityQuery(message);
  if (!query) return null;

  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return null;
    const [, titles] = await searchRes.json();
    if (!titles || !titles.length) return null;

    const title = titles[0];
    const summaryRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (!summaryRes.ok) return null;
    const data = await summaryRes.json();
    if (!data.extract) return null;

    return {
      title: data.title,
      description: data.description || null, // short category line, e.g. "American businessman"
      extract: data.extract,
      thumbnail: data.thumbnail?.source || null,
      wikipediaUrl: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    };
  } catch (err) {
    console.error('wikipedia lookup failed:', err.message);
    return null;
  }
}

module.exports = { lookupWikipediaEntity };
