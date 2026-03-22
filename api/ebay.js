module.exports = async function handler(req, res) {
  const buildSmartSearchQueries = require("../lib/build-smart-search-queries");

  const query = (req.query.q || "").trim();
  const smart = req.query.smart === "1";

  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    const queryPlan = smart
      ? await buildSmartSearchQueries({ query })
      : { primary_query: query, alternate_queries: [] };

    const searchTerms = [
      queryPlan.primary_query,
      ...queryPlan.alternate_queries
    ].filter(Boolean);

    const auth = Buffer.from(
      process.env.EBAY_CLIENT_ID + ":" + process.env.EBAY_CLIENT_SECRET
    ).toString("base64");

    const tokenRes = await fetch(
      "https://api.ebay.com/identity/v1/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + auth
        },
        body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope"
      }
    );

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      return res.status(500).json({
        error: "Failed to get eBay access token",
        details: tokenData
      });
    }

    const resultSets = await Promise.all(
      searchTerms.map(async (term) => {
        const searchRes = await fetch(
          `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(term)}&limit=12`,
          {
            headers: {
              Authorization: "Bearer " + tokenData.access_token
            }
          }
        );

        const searchData = await searchRes.json();

        if (!searchRes.ok) {
          return [];
        }

        return Array.isArray(searchData.itemSummaries) ? searchData.itemSummaries : [];
      })
    );

    const merged = dedupeEbayItems(resultSets.flat()).slice(0, 12);

    return res.status(200).json({
      source: "ebay",
      query,
      smart_search: smart,
      search_terms: searchTerms,
      itemSummaries: merged
    });
  } catch (err) {
    return res.status(500).json({
      error: "API error",
      details: String(err)
    });
  }
};

function dedupeEbayItems(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key =
      item.itemWebUrl ||
      item.itemId ||
      `${item.title || ""}|${item.price?.value || ""}`;

    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}
