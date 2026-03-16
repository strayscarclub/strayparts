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
      `&limit=5` +
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

    return res.status(200).json({
      apiUrl,
      topLevelKeys: Object.keys(data || {}),
      sample: data
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to debug Up Garage",
      details: String(error)
    });
  }
};
