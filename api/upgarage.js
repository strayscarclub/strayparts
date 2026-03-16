module.exports = async function handler(req, res) {
  const query = (req.query.q || "").trim();

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
      `&limit=20` +
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

    const rawItems = Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.data?.items)
      ? data.data.items
      : Array.isArray(data)
      ? data
      : [];

    const items = rawItems.map((item) => {
      const title =
        item.item_name ||
        item.name ||
        item.title ||
        "Untitled listing";

      const itemUrl =
        item.item_url ||
        item.url ||
        (item.item_id ? `https://www.upgarage.com/en/ec/item/${item.item_id}/` : "#");

      const imageUrl =
        item.image_url ||
        item.image ||
        item.thumbnail_url ||
        item.thumb ||
        "";

      const price =
        item.price_text ||
        item.display_price ||
        (item.price ? `¥${Number(item.price).toLocaleString("en-US")}` : "Price not available");

      return {
        title,
        item_url: itemUrl,
        image_url: imageUrl,
        price,
        marketplace: "Up Garage"
      };
    });

    return res.status(200).json({
      source: "upgarage",
      query,
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
