const cheerio = require("cheerio");
const normalizeListings = require("../lib/normalize-listings");

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; StrayPartsBot/1.0; +https://www.strayparts.io)",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
};

module.exports = async function handler(req, res) {
  const query = (req.query.q || "").trim();
  const debug = req.query.debug === "1";
  const smart = req.query.smart === "1";

  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    const searchUrl = `https://auctions.yahoo.co.jp/search/search/${encodeURIComponent(query)}/0/`;

    const response = await fetch(searchUrl, {
      headers: DEFAULT_HEADERS
    });

    const html = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Failed to fetch Yahoo Auctions search page",
        status: response.status
      });
    }

    const searchPageItems = extractYahooSearchItems(html);

    if (debug) {
      return res.status(200).json({
        source: "yahooauctions",
        query,
        search_url: searchUrl,
        extracted_count: searchPageItems.length,
        items_preview: searchPageItems.slice(0, 5),
        html_preview: html.slice(0, 3000)
      });
    }

    if (searchPageItems.length === 0) {
      return res.status(200).json({
        source: "yahooauctions",
        query,
        count: 0,
        items: []
      });
    }

    // Keep the list tight for speed.
    const limitedItems = searchPageItems.slice(0, 12);

    // Only fetch detail pages for incomplete items, and cap concurrency.
    const completedItems = await mapWithConcurrency(
      limitedItems,
      4,
      async (item) => {
        if (isSearchItemComplete(item)) {
          return finalizeYahooItem(item);
        }

        try {
          const detailItem = await fetchYahooAuctionItem(item.item_url);
          return finalizeYahooItem({
            ...item,
            ...detailItem
          });
        } catch (error) {
          return finalizeYahooItem(item);
        }
      }
    );

    let items = completedItems.filter(Boolean);

    items = await normalizeListings({
      source: "Yahoo Auctions",
      query,
      items,
      shouldNormalize: smart
    });

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

function extractYahooSearchItems(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  // Look for links to auction items and build items from the nearest result block.
  $('a[href*="/jp/auction/"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const itemUrl = absolutizeYahooAuctionUrl(href);

    if (!itemUrl || seen.has(itemUrl)) return;

    const card = findLikelyResultCard($, el);
    const title = extractTitleFromCard($, el, card);
    const imageUrl = extractImageFromCard($, el, card);
    const cardText = cleanText(card.text() || "");

    const item = {
      title: cleanTitle(title),
      item_url: itemUrl,
      image_url: absolutize(imageUrl),
      price: formatYahooPrice(extractPrice(cardText)),
      shipping: cleanShipping(extractShipping(cardText)),
      time_left: cleanTimeLeft(extractTimeLeft(cardText)),
      marketplace: "Yahoo Auctions"
    };

    // Only keep results that at least look like real auction items.
    if (item.title || item.price || item.image_url) {
      seen.add(itemUrl);
      results.push(item);
    }
  });

  return results;
}

function findLikelyResultCard($, el) {
  const candidates = [
    $(el).closest("li"),
    $(el).closest("article"),
    $(el).closest("section"),
    $(el).closest("div")
  ];

  for (const candidate of candidates) {
    const text = cleanText(candidate.text() || "");
    if (candidate.length && text.length > 20) {
      return candidate;
    }
  }

  return $(el).parent();
}

function extractTitleFromCard($, el, card) {
  const linkText = cleanText($(el).text() || "");
  if (linkText && linkText.length > 4) return linkText;

  const headings = [
    card.find("h1").first().text(),
    card.find("h2").first().text(),
    card.find("h3").first().text(),
    card.find('[class*="title"]').first().text()
  ];

  for (const value of headings) {
    const clean = cleanText(value || "");
    if (clean) return clean;
  }

  return "";
}

function extractImageFromCard($, el, card) {
  const img =
    card.find('img[src]').first().attr("src") ||
    card.find('img[data-src]').first().attr("data-src") ||
    $(el).find('img[src]').first().attr("src") ||
    "";

  return img;
}

function isSearchItemComplete(item) {
  return !!(item.title && item.price && item.image_url);
}

async function fetchYahooAuctionItem(itemUrl) {
  const response = await fetch(itemUrl, {
    headers: DEFAULT_HEADERS
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
    $("img").first().attr("src") ||
    "";

  const bodyText = cleanText($("body").text());

  return {
    title: cleanTitle(title),
    item_url: itemUrl,
    image_url: absolutize(imageUrl),
    price: formatYahooPrice(extractPrice(bodyText)),
    shipping: cleanShipping(extractShipping(bodyText)),
    time_left: cleanTimeLeft(extractTimeLeft(bodyText)),
    marketplace: "Yahoo Auctions"
  };
}

function finalizeYahooItem(item) {
  return {
    title: cleanTitle(item.title || ""),
    item_url: item.item_url || "",
    image_url: absolutize(item.image_url || ""),
    price: formatYahooPrice(item.price || "") || "Price not available",
    shipping: cleanShipping(item.shipping || ""),
    time_left: cleanTimeLeft(item.time_left || ""),
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

function formatYahooPrice(raw) {
  if (!raw) return "";

  const numeric = String(raw).match(/[\d,]+/);
  if (!numeric) return "";

  return `¥${numeric[0]}`;
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

function cleanShipping(raw) {
  if (!raw) return "";

  if (raw.includes("送料無料")) return "Free shipping";
  if (raw.includes("送料未定")) return "Shipping unknown";

  const numeric = raw.match(/[\d,]+/);
  if (numeric) return `Shipping: ¥${numeric[0]}`;

  return raw;
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

function cleanTimeLeft(raw) {
  if (!raw) return "";

  const dayMatch = raw.match(/(\d+)日/);
  if (dayMatch) return `${dayMatch[1]} days left`;

  const hourMatch = raw.match(/(\d+)時間/);
  if (hourMatch) return `${hourMatch[1]} hours left`;

  const minMatch = raw.match(/(\d+)分/);
  if (minMatch) return `${minMatch[1]} mins left`;

  return raw;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      } catch (error) {
        results[currentIndex] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
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

function absolutizeYahooAuctionUrl(url) {
  if (!url) return "";
  if (url.startsWith("https://page.auctions.yahoo.co.jp/jp/auction/")) return cleanUrl(url);
  if (url.startsWith("/jp/auction/")) return cleanUrl(`https://page.auctions.yahoo.co.jp${url}`);
  return "";
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
