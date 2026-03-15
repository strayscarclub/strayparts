const cheerio = require("cheerio");

module.exports = async function handler(req, res) {
  const query = (req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    const searchUrl = `https://www.upgarage.com/en/ec/search/?dd_bunrui_cd=01&search_word=${encodeURIComponent(query)}`;

    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; StrayPartsBot/1.0; +https://www.strayparts.io)"
      }
    });

    const html = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Failed to fetch Up Garage results",
        status: response.status
      });
    }

    const results = parseUpGarageResults(html);

    return res.status(200).json({
      source: "upgarage",
      query,
      count: results.length,
      items: results.slice(0, 12)
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to search Up Garage",
      details: String(error)
    });
  }
};

function parseUpGarageResults(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  // Broad approach: find item links first, then read nearby title/image/price.
  $('a[href*="/en/ec/item/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const itemUrl = absoluteUrl(href);
    if (seen.has(itemUrl)) return;

    const card = $(el).closest("li, article, div");
    const cardText = normalizeWhitespace(card.text());

    const title =
      normalizeWhitespace($(el).find("img").attr("alt")) ||
      normalizeWhitespace($(el).text()) ||
      extractTitleFromText(cardText);

    const imageUrl = absoluteUrl(
      $(el).find("img").attr("src") ||
      $(el).find("img").attr("data-src") ||
      card.find("img").first().attr("src") ||
      card.find("img").first().attr("data-src") ||
      ""
    );

    const price = extractPrice(cardText);

    if (!title) return;

    seen.add(itemUrl);

    items.push({
      title,
      item_url: itemUrl,
      image_url: imageUrl,
      price: price || "Price not available",
      marketplace: "Up Garage"
    });
  });

  return items;
}

function absoluteUrl(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.upgarage.com${url}`;
  return `https://www.upgarage.com/${url}`;
}

function normalizeWhitespace(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

function extractPrice(text) {
  const cleaned = normalizeWhitespace(text);

  // Try yen formats first
  const yenMatch =
    cleaned.match(/¥\s?[\d,]+/) ||
    cleaned.match(/JPY\s?[\d,]+/i) ||
    cleaned.match(/[\d,]+\s?yen/i);

  if (yenMatch) return yenMatch[0];

  return "";
}

function extractTitleFromText(text) {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) return "";

  // Fallback: use the first chunk before price-ish text
  const split = cleaned.split(/¥|JPY|yen/i)[0].trim();
  return split || cleaned.slice(0, 120);
}
