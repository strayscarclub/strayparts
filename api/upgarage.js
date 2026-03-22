const normalizeListings = require("../lib/normalize-listings");
const buildSmartSearchQueries = require("../lib/build-smart-search-queries");

module.exports = async function handler(req, res) {
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

    const rawResults = await Promise.all(
      searchTerms.map((term) => fetchUpGarageSearch(term))
    );

    let items = rawResults.flat();

    items = dedupeItems(items).slice(0, 18);

    items = await normalizeListings({
      source: "Up Garage",
      query,
      items,
      shouldNormalize: smart
    });

    return res.status(200).json({
      source: "upgarage",
      query,
      smart_search: smart,
      search_terms: searchTerms,
      count: items.length,
      items
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to search Up Garage",
      details: String(error)
    });
  }
};

async function fetchUpGarageSearch(searchTerm) {
  const apiUrl =
    `https://www.upgarage.com/service/api/v1/items` +
    `?dd_bunrui_cd=01` +
    `&search_word=${encodeURIComponent(searchTerm)}` +
    `&order_by=arrival_date` +
    `&sort_order=desc` +
    `&limit=12` +
    `&offset=0` +
    `&view_type=tile` +
    `&lang=en`;

  const response = await fetch(apiUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; StrayPartsBot/1.0; +https://www.strayparts.io)",
      Accept: "application/json"
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to fetch Up Garage API: ${response.status}`);
  }

  const rawItems = Array.isArray(data?.resources) ? data.resources : [];

  return rawItems.map((item) => {
    const title = cleanTitle(item.name || "Untitled listing");
    const itemUrl = item.id
      ? `https://www.upgarage.com/en/ec/item/${item.id}/`
      : "#";

    const imageUrl = item.image_url || "";

    const price =
      item.tax_included_price
        ? `¥${Number(item.tax_included_price).toLocaleString("en-US")}`
        : item.price
        ? `¥${Number(item.price).toLocaleString("en-US")}`
        : "Price not available";

    return {
      title,
      item_url: itemUrl,
      image_url: imageUrl,
      price,
      marketplace: "Up Garage",
      shop_name: item.shop_name || "",
      category: item.s_bunrui_name || "",
      condition: item.condition || ""
    };
  });
}

function dedupeItems(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key =
      item.item_url ||
      `${item.title || ""}|${item.price || ""}|${item.image_url || ""}`;

    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

function cleanTitle(str) {
  return String(str || "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
