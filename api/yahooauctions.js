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

    const itemUrls = extractYahooItemUrls(html);

    if (debug) {
      return res.status(200).json({
        source: "yahooauctions",
        query,
        search_url: searchUrl,
        item_url_count: itemUrls.length,
        item_urls: itemUrls.slice(0, 10),
        html_preview: html.slice(0, 3000)
      });
    }

    if (itemUrls.length === 0) {
      return res.status(200).json({
        source: "yahooauctions",
        query,
        count: 0,
        items: []
      });
    }

    const limitedUrls = itemUrls.slice(0, 12);

    const itemResults = await Promise.all(
      limitedUrls.map(async (url) => {
        try {
          return await fetchYahooAuctionItem(url);
        } catch (error) {
          return null;
        }
      })
    );

    const items = itemResults.filter(Boolean);

    return res.status(200).json({
      source: "yahooauctions",
      query,
      count: items.length,
      items
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to search Yahoo Auctions",
      details: String(error)
    });
  }
};

function extractYahooItemUrls(html) {
  const urls = new Set();

  // Absolute auction item URLs
  const absoluteMatches =
    html.match(/https:\/\/page\.auctions\.yahoo\.co\.jp\/jp\/auction\/[a-zA-Z0-9]+/g) || [];
  absoluteMatches.forEach((url) => urls.add(cleanUrl(url)));

  // Relative auction item URLs
  const relativeMatches =
    html.match(/\/jp\/auction\/[a-zA-Z0-9]+/g) || [];
  relativeMatches.forEach((url) => {
    urls.add(cleanUrl(`https://page.auctions.yahoo.co.jp${url}`));
  });

  return Array.from(urls);
}

async function fetchYahooAuctionItem(itemUrl) {
  const response = await fetch(itemUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; StrayPartsBot/1.0; +https://www.strayparts.io)",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
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

  const bodyText = cleanText($("body").text());

  const price =
    extractPrice(bodyText) ||
    "Price not available";

  const shipping =
    extractShipping(bodyText) ||
    "";

  const timeLeft =
    extractTimeLeft(bodyText) ||
    "";

  return {
    title: cleanTitle(title),
    item_url: itemUrl,
    image_url: absolutize(imageUrl),
    price,
    shipping,
    time_left: timeLeft,
    marketplace: "Yahoo Auctions"
  };
}

function extractPrice(text) {
  if (!text) return "";

  return (
    text.match(/現在\s*価格\s*[\d,]+円/)?.[0] ||
    text.match(/現在\s*[\d,]+円/)?.[0] ||
    text.match(/即決\s*価格\s*[\d,]+円/)?.[0] ||
    text.match(/即決\s*[\d,]+円/)?.[0] ||
    text.match(/[\d,]+円/)?.[0] ||
    ""
  );
}

function extractShipping(text) {
  if (!text) return "";

  return (
    text.match(/送料無料/)?.[0] ||
    text.match(/送料未定/)?.[0] ||
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

function cleanTitle(str) {
  return String(str || "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s*【[^】]*】\s*/, "")
    .trim();
}

function cleanText(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

function cleanUrl(url) {
  return String(url || "").replace(/["'\\]/g, "");
}

function absolutize(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://page.auctions.yahoo.co.jp${url}`;
  return url;
}
