const normalizeListings = require("../lib/normalize-listings");

module.exports = async function handler(req, res) {
  const query = (req.query.q || "").trim();
  const smart = req.query.smart === "1";
  const matchMode = req.query.match === "broad" ? "broad" : "exact";

  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    const apiUrl =
      `https://www.upgarage.com/service/api/v1/items` +
      `?dd_bunrui_cd=01` +
      `&search_word=${encodeURIComponent(query)}` +
      `&order_by=arrival_date` +
      `&sort_order=desc` +
      `&limit=12` +
      `&offset=0` +
      `&view_type=tile` +
      `&lang=en`;

    const response = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; StrayPartsBot/1.0; +https://www.strayparts.io)",
        "Accept": "application/json"
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Failed to fetch Up Garage API",
        status: response.status,
        details: data
      });
    }

    const rawItems = Array.isArray(data?.resources) ? data.resources : [];

    let items = rawItems.map((item) => {
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

    items = await normalizeListings({
      source: "Up Garage",
      query,
      items,
      shouldNormalize: smart,
      matchMode
    });

    return res.status(200).json({
      source: "upgarage",
      query,
      match_mode: matchMode,
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

function cleanTitle(str) {
  return String(str || "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
