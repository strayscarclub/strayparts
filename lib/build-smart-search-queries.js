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
        maxItems: 3
      }
    },
    required: ["primary_query", "alternate_queries"]
  };

  const prompt = `
You expand car-part search queries for an enthusiast marketplace search tool.

Goal:
- Improve retrieval, not just wording.
- Decide automatically whether the query is very specific or naturally broader.
- Keep very specific searches tight.
- Broaden category-style searches sensibly.
- Include only highly useful alternate search terms that could produce genuinely relevant part listings.
- Prefer precision first, then broaden only where it clearly helps.

Rules:
- Do not generate more than 3 alternate queries.
- Do not invent nonsense or overly broad generic terms.
- Preserve chassis codes, engine codes, model names, part names, and enthusiast shorthand.
- Japanese or translated equivalents are allowed where they would realistically help marketplace retrieval.
- If the search is already very specific, alternate_queries can be empty.
- primary_query should usually be the original query, lightly cleaned only if necessary.

Examples:
- "gc8 turbo" -> stay fairly tight
- "ej207 engine" -> stay tight
- "recaro confetti" -> stay tight
- "race seats" -> broader related terms are okay
- "bucket seats" -> broader related terms are okay
- "s13 coilovers" -> fairly tight with close variations
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
          .slice(0, 3)
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
