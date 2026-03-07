export default async function handler(req, res) {
  const q = (req.query.q || "").trim();

  if (!q) {
    return res.status(400).json({ error: "Missing search query" });
  }

  try {
    const ebayRssUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_rss=1`;
    const response = await fetch(ebayRssUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 StrayPartsBot/1.0"
      }
    });

    const xml = await response.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6);

    const results = items.map((match) => {
      const itemXml = match[1];

      const getTag = (tag) => {
        const m = itemXml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
        return m ? decode(m[1]) : "";
      };

      return {
        title: getTag("title"),
        link: getTag("link"),
        description: getTag("description")
      };
    });

    return res.status(200).json({ items: results });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to fetch eBay results"
    });
  }
}

function decode(str) {
  return str
    .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
