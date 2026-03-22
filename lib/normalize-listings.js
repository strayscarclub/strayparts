module.exports = async function normalizeListings({
  source,
  query,
  items,
  shouldNormalize
}) {
  if (!shouldNormalize) return items;
  if (!process.env.OPENAI_API_KEY) return items;
  if (!items || !items.length) return items;

  const limitedItems = items.slice(0, 12).map((item, idx) => ({
    idx,
    title: item.title || "",
    price: item.price || "",
    marketplace: item.marketplace || source || "",
    shop_name: item.shop_name || "",
    category: item.category || ""
  }));

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            idx: { type: "integer" },
            display_title: { type: "string" },
            english_hint: { type: "string" },
            relevance_note: { type: "string" }
          },
          required: ["idx", "display_title", "english_hint", "relevance_note"]
        }
      }
    },
    required: ["items"]
  };

  const prompt = `
You clean and normalize marketplace titles for JDM and enthusiast car part searches.

Search query: ${query}

Your job:
- Improve user-facing listing titles for Stray Parts.
- Translate Japanese into natural English where helpful.
- Keep titles concise, useful, and enthusiast-friendly.
- Preserve brand, model, chassis code, engine code, and part information.
- Do not invent specs, fitment, condition, or compatibility details.
- If a title is already clear, only lightly improve it.
- "display_title" should be the best user-facing title.
- "english_hint" should be a short supporting clarification in English if useful, otherwise empty.
- "relevance_note" is internal only and should be very short.

Smart Search behaviour:
- Decide automatically whether the query is very specific or naturally broad.
- If the query is very specific, keep results framed tightly around that part and close naming variations.
- If the query is more category-like or discovery-oriented, allow related enthusiast terms, translated equivalents, and common alternative naming where reasonable.
- Help discovery, but do not make weak matches sound stronger than they are.
- Prefer precision first, but allow sensible variations where they clearly help.

Examples:
- "gc8 turbo" should stay fairly tight, while allowing very close GC8 turbo variations and strongly relevant naming.
- "race seats" can be treated more broadly, allowing relevant alternatives like bucket seats, semi-bucket seats, and known enthusiast seat brands where appropriate.
- "ej207 engine" should stay quite focused.
- "recaro confetti" should stay tightly aligned to that style/product naming.

Your job is NOT to invent results or filter them out entirely.
Your job is to make the returned results clearer, more useful, and better aligned with how an enthusiast would naturally search.
`;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          {
            role: "system",
            content: prompt
          },
          {
            role: "user",
            content: JSON.stringify({
              source,
              query,
              items: limitedItems
            })
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "listing_normalization",
            schema
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI normalize error:", data);
      return items;
    }

    const rawText =
      data.output_text ||
      extractOutputText(data) ||
      "";

    if (!rawText) return items;

    const parsed = JSON.parse(rawText);
    const byIdx = new Map((parsed.items || []).map(item => [item.idx, item]));

    return items.map((item, idx) => {
      const normalized = byIdx.get(idx);
      if (!normalized) return item;

      return {
        ...item,
        display_title: normalized.display_title || item.title,
        english_hint: normalized.english_hint || "",
        relevance_note: normalized.relevance_note || ""
      };
    });
  } catch (error) {
    console.error("OpenAI normalize exception:", error);
    return items;
  }
};

function extractOutputText(data) {
  try {
    const outputs = data.output || [];
    for (const out of outputs) {
      const content = out.content || [];
      for (const part of content) {
        if (typeof part.text === "string" && part.text.trim()) {
          return part.text;
        }
      }
    }
  } catch (e) {
    return "";
  }
  return "";
}
