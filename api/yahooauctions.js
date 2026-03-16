const cheerio = require("cheerio");

module.exports = async function handler(req, res) {
  const query = (req.query.q || "").trim();
  const debug = req.query.debug === "1";

  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    const searchUrl = `https://auctions.yahoo.co.jp/search/search/${encodeURIComponent(query)}/0/`;

    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; StrayPartsBot/1.0; +https://www.strayparts.io)",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
      }
    });

    const html = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Failed to fetch Yahoo Auctions search page",
        status: response.status
      });
    }

    const items = parseYahooAuctionsResults(html);

    if (debug) {
      return res.status(200).json({
        source: "yahooauctions",
        query,
        search_url: searchUrl,
        count: items.length,
        items: items.slice(0, 5),
        html_preview: html.slice(0, 3000)
      });
    }

    return res.status(200).json({
      source: "yahooauctions",
      query,
      count: items.length,
      items: items.slice(0, 20)
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to search Yahoo Auctions",
      details: String(error)
    });
  }
};

function parseYahooAuctionsResults(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  // Yahoo Auctions item pages usually live under page.auctions.yahoo.co.jp/jp/auction/
  $('a[href*="page.auctions.yahoo.co.jp/jp/auction/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const itemUrl = absolutize(href);
    if (!itemUrl || seen.has(itemUrl)) return;

    const card = $(el).closest("li, article, section, div");
    const title =
      cleanText($(el).text()) ||
      cleanText($(el).attr("title")) ||
      cleanText(card.find("img").first().attr("alt")) ||
      "Untitled listing";

    const imageUrl = absolutize(
      card.find("img").first().attr("src") ||
      card.find("img").first().attr("data-src") ||
      ""
    );

    const textBlob = cleanText(card.text());
    const price = extractPrice(textBlob);
    const shipping = extractShipping(textBlob);
    const timeLeft = extractTimeLeft(textBlob);

    seen.add(itemUrl);

    items.push({
      title,
      item_url: itemUrl,
      image_url: imageUrl,
      price: price || "Price not available",
      shipping: shipping || "",
      time_left: timeLeft || "",
      marketplace: "Yahoo Auctions"
    });
  });

  return items;
}

function extractPrice(text) {
  if (!text) return "";
  return (
    text.match(/現在\s*[\d,]+円/)?.[0] ||
    text.match(/即決\s*[\d,]+円/)?.[0] ||
    text.match(/[\d,]+円〜/)?.[0] ||
    text.match(/[\d,]+円/)?.[0] ||
    ""
  );
}

function extractShipping(text) {
  if (!text) return "";
  return (
    text.match(/送料未定/)?.[0] ||
    text.match(/送料無料/)?.[0] ||
    text.match(/送料[\d,]+円/)?.[0] ||
    text.match(/＋送料[\d,]+円/)?.[0] ||
    ""
  );
}

function extractTimeLeft(text) {
  if (!text) return "";
  return (
    text.match(/残り\s*\d+日/)?.[0] ||
    text.match(/残り\s*\d+時間/)?.[0] ||
    text.match(/残り\s*\d+分/)?.[0] ||
    ""
  );
}

function cleanText(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

function absolutize(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://auctions.yahoo.co.jp${url}`;
  return url;
}
