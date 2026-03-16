module.exports = async function normalizeListings({ source, query, items, shouldNormalize }) {
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
            english_hint: { type: "string" }
          },
          required: ["idx", "display_title", "english_hint"]
        }
      }
    },
    required: ["items"]
  };

  const prompt = `
You clean and normalize marketplace titles for JDM enthusiasts.

Rules:
- Keep titles concise and useful.
- Translate Japanese into natural English where helpful.
- Do not invent specs or condition details.
- Preserve brand, model, and part information.
- If a title is already clear, only lightly improve it.
- "display_title" should be the best user-facing title for Stray Parts.
- "english_hint" should be a short supporting clarification in English if useful, otherwise empty.
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
        english_hint: normalized.english_hint || ""
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
