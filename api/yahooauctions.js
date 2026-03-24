const cheerio = require("cheerio");
const normalizeListings = require("../lib/normalize-listings");
const buildSmartSearchQueries = require("../lib/build-smart-search-queries");
const filterSmartSearchResults = require("../lib/filter-smart-search-results");

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
    let alternateQueries = [];

    if (smart) {
      const queryPlan = await buildSmartSearchQueries({ query });
      alternateQueries = Array.isArray(queryPlan.alternate_queries)
        ? queryPlan.alternate_queries.filter(Boolean)
        : [];
    }

    const searchTerms = [query, ...alternateQueries].filter(Boolean);

    if (debug) {
      return res.status(200).json({
        source: "yahooauctions",
        query,
        smart_search: smart,
        search_terms: searchTerms
      });
    }

    const baseItems = await searchYahooBySingleQuery(query);

    let alternateItems = [];
    if (smart && alternateQueries.length > 0) {
      const alternateResults = await Promise.all(
        alternateQueries.map((term) => searchYahooBySingleQuery(term).catch(() => []))
      );
      alternateItems = alternateResults.flat();
    }

    let items = dedupeItems([...baseItems, ...alternateItems]).slice(0, 12);

    if (smart) {
      items = await filterSmartSearchResults({
        query,
        items,
        source: "Yahoo Auctions"
      });
    }

    items = await normalizeListings({
      source: "Yahoo Auctions",
      query,
      items,
      shouldNormalize: smart
    });

    return res.status(200).json({
      source: "yahooauctions",
      query,
      smart_search: smart,
      search_terms: searchTerms,
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

async function searchYahooBySingleQuery(searchTerm) {
  const searchUrl = `https://auctions.yahoo.co.jp/search/search/${encodeURIComponent(searchTerm)}/0/`;

  const response = await fetch(searchUrl, {
    headers: DEFAULT_HEADERS
  });

  const html = await response.text();

  if (!response.ok) {
    throw new Error(`Failed Yahoo search page fetch: ${response.status}`);
  }

  const itemUrls = extractYahooItemUrls(html);
  if (itemUrls.length === 0) return [];

  const limitedUrls = itemUrls.slice(0, 8);

  const itemResults = await mapWithConcurrency(limitedUrls, 4, async (url) => {
    try {
      return await fetchYahooAuctionItem(url);
    } catch (error) {
      return null;
    }
  });

  return itemResults.filter(Boolean);
}

function extractYahooItemUrls(html) {
  const urls = new Set();

  const absoluteMatches =
    html.match(/https:\/\/page\.auctions\.yahoo\.co\.jp\/jp\/auction\/[a-zA-Z0-9]+/g) || [];
  absoluteMatches.forEach((url) => urls.add(cleanUrl(url)));

  const relativeMatches =
    html.match(/\/jp\/auction\/[a-zA-Z0-9]+/g) || [];
  relativeMatches.forEach((url) => {
    urls.add(cleanUrl(`https://page.auctions.yahoo.co.jp${url}`));
  });

  return Array.from(urls);
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

  const price = formatYahooPrice(extractPrice(bodyText)) || "Price not available";
  const shipping = cleanShipping(extractShipping(bodyText)) || "";
  const timeLeft = cleanTimeLeft(extractTimeLeft(bodyText)) || "";

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
