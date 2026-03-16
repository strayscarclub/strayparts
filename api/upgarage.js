const cheerio = require("cheerio");

module.exports = async function handler(req, res) {
  const query = (req.query.q || "").trim();
  const debug = req.query.debug === "1";

  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    const searchUrl = `https://www.upgarage.com/en/ec/search/?dd_bunrui_cd=01&search_word=${encodeURIComponent(query)}`;

    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; StrayPartsBot/1.0; +https://www.strayparts.io)",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const html = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Failed to fetch Up Garage search page",
        status: response.status
      });
    }

    const itemUrls = extractItemUrls(html);

    if (debug) {
      return res.status(200).json({
        source: "upgarage",
        query,
        search_url: searchUrl,
        item_url_count: itemUrls.length,
        item_urls: itemUrls.slice(0, 20),
        html_preview: html.slice(0, 3000)
      });
    }

    if (itemUrls.length === 0) {
      return res.status(200).json({
        source: "upgarage",
        query,
        count: 0,
        items: []
      });
    }

    const limitedUrls = itemUrls.slice(0, 12);

    const itemResults = await Promise.all(
      limitedUrls.map(async (url) => {
        try {
          return await fetchUpGarageItem(url);
        } catch (error) {
          return null;
        }
      })
    );

    const items = itemResults.filter(Boolean);

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

function extractItemUrls(html) {
  const urls = new Set();

  // Absolute item URLs
  const absoluteMatches = html.match(/https:\/\/www\.upgarage\.com\/en\/ec\/item\/\d+\/?/g) || [];
  absoluteMatches.forEach((url) => urls.add(cleanItemUrl(url)));

  // Relative item URLs
  const relativeMatches = html.match(/\/en\/ec\/item\/\d+\/?/g) || [];
  relativeMatches.forEach((url) => urls.add(cleanItemUrl(`https://www.upgarage.com${url}`)));

  return Array.from(urls);
}

function cleanItemUrl(url) {
  if (!url) return "";
  return url.replace(/["'\\]/g, "");
}

async function fetchUpGarageItem(itemUrl) {
  const response = await fetch(itemUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; StrayPartsBot/1.0; +https://www.strayparts.io)",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  const html = await response.text();

  if (!response.ok) {
    throw new Error(`Failed item fetch: ${response.status}`);
  }

  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").text().trim() ||
    "";

  const imageUrl =
    $('meta[property="og:image"]').attr("content") ||
    $('img').first().attr("src") ||
    "";

  const text = normalizeWhitespace($("body").text());

  const price =
    extractPrice(text) ||
    extractPrice($.html()) ||
    "Price not available";

  return {
    title: normalizeWhitespace(title),
    item_url: itemUrl,
    image_url: absolutizeUpGarageUrl(imageUrl),
    price,
    marketplace: "Up Garage"
  };
}

function extractPrice(text) {
  if (!text) return "";

  const cleaned = normalizeWhitespace(text);

  const yenMatch =
    cleaned.match(/¥\s?[\d,]+/) ||
    cleaned.match(/JPY\s?[\d,]+/i) ||
    cleaned.match(/[\d,]+\s?yen/i);

  return yenMatch ? yenMatch[0] : "";
}

function normalizeWhitespace(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

function absolutizeUpGarageUrl(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.upgarage.com${url}`;
  return `https://www.upgarage.com/${url}`;
}
