module.exports = async function filterSmartSearchResults({
  query,
  items,
  source
}) {
  if (!items || !items.length) return items;
  if (!process.env.OPENAI_API_KEY) return items;

  const limitedItems = items.slice(0, 18).map((item, idx) => ({
    idx,
    title: item.title || "",
    marketplace: item.marketplace || source || "",
    category: item.category || "",
    shop_name: item.shop_name || "",
    price: item.price || ""
  }));

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      keep: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            idx: { type: "integer" },
            keep: { type: "boolean" }
          },
          required: ["idx", "keep"]
        }
      }
    },
    required: ["keep"]
  };

  const prompt = `
You are filtering search results for an enthusiast car-part search tool focused on JDM and enthusiast automotive parts.

Search query: ${query}
Marketplace/source: ${source || ""}

Goal:
Keep only results that are genuinely relevant to the search query within the automotive / enthusiast car parts space.

Rules:
- Reject non-automotive items.
- Reject memorabilia, CDs, signs, posters, parody items, toys, books, stickers, general merchandise, and unrelated collectibles unless the query clearly asks for them.
- Reject results that only match a weak word fragment but are not actually the searched part.
- Keep results that are genuinely relevant automotive parts, wheels, accessories, or closely related enthusiast items.
- Be conservative: if a result is weakly related or likely wrong, reject it.
- For wheel/rim searches, keep only listings that are clearly about wheels/rims or highly relevant automotive wheel products.
- For engine/turbo/seat/suspension searches, keep only clearly relevant automotive listings.
- Do not keep an item just because it contains words like "for sale" or another accidental phrase match.

Return only whether each item should be kept.
`;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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
              query,
              source,
              items: limitedItems
            })
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "smart_result_filter",
            schema
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI filter error:", data);
      return items;
    }

    const rawText = data.output_text || extractOutputText(data) || "";
    if (!rawText) return items;

    const parsed = JSON.parse(rawText);
    const keepMap = new Map((parsed.keep || []).map((row) => [row.idx, !!row.keep]));

    return items.filter((item, idx) => keepMap.get(idx) !== false);
  } catch (error) {
    console.error("OpenAI filter exception:", error);
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
