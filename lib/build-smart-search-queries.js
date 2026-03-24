module.exports = async function buildSmartSearchQueries({ query }) {
  const baseQuery = String(query || "").trim();

  if (!baseQuery) {
    return {
      primary_query: "",
      alternate_queries: []
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      primary_query: baseQuery,
      alternate_queries: []
    };
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      primary_query: { type: "string" },
      alternate_queries: {
        type: "array",
        items: { type: "string" },
        maxItems: 1
      }
    },
    required: ["primary_query", "alternate_queries"]
  };

  const prompt = `
You expand car-part search queries for an enthusiast marketplace search tool focused on JDM and enthusiast automotive parts.

Search query: ${baseQuery}

Goal:
- Improve retrieval, not just wording.
- Stay conservative.
- Preserve relevance.
- Do not broaden unless it clearly helps inside the automotive / enthusiast car parts space.

Rules:
- Return at most 1 alternate query.
- For very specific searches, return no alternate queries unless an extremely close variation is clearly useful.
- If the query contains a specific part name, product code, model code, chassis code, engine code, or brand-specific item, prefer zero alternate queries unless a very close variation is clearly useful.
- For category-style searches, you may return one highly relevant enthusiast alternative.
- Do not generate overly broad generic terms.
- Do not generate terms that drift outside the likely intended automotive part.
- Preserve chassis codes, engine codes, model names, part names, and enthusiast shorthand.
- Japanese or translated equivalents are allowed only if they would realistically help automotive marketplace retrieval.
- primary_query should usually stay the same as the user's query, unless very light cleanup helps.

Good behaviour:
- "gc8 turbo" -> stay tight
- "ej207 engine" -> stay tight
- "recaro confetti" -> stay tight
- "lmgt4 rims" -> stay tight
- "s13 coilovers" -> stay tight
- "race seats" -> one strong enthusiast alternative is okay
- "bucket seats" -> one strong enthusiast alternative is okay

Bad behaviour:
- Do not turn a specific search into a generic category search.
- Do not generate weakly related terms just to fill space.
- Do not generate non-automotive alternatives.
- Do not generate more than 1 alternate.
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
            content: JSON.stringify({ query: baseQuery })
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "smart_search_queries",
            schema
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI query expansion error:", data);
      return {
        primary_query: baseQuery,
        alternate_queries: []
      };
    }

    const rawText = data.output_text || extractOutputText(data) || "";

    if (!rawText) {
      return {
        primary_query: baseQuery,
        alternate_queries: []
      };
    }

    const parsed = JSON.parse(rawText);

    const primary = String(parsed.primary_query || baseQuery).trim() || baseQuery;
    const alternates = Array.isArray(parsed.alternate_queries)
      ? parsed.alternate_queries
          .map((q) => String(q || "").trim())
          .filter(Boolean)
          .filter((q) => q.toLowerCase() !== primary.toLowerCase())
          .slice(0, 1)
      : [];

    return {
      primary_query: primary,
      alternate_queries: alternates
    };
  } catch (error) {
    console.error("OpenAI query expansion exception:", error);
    return {
      primary_query: baseQuery,
      alternate_queries: []
    };
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
