const { createClient } = require("@supabase/supabase-js");
const cheerio = require("cheerio");
const normalizeListings = require("../lib/normalize-listings");
const buildSmartSearchQueries = require("../lib/build-smart-search-queries");

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; StrayPartsBot/1.0; +https://www.strayparts.io)"
};

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization;

  if (authHeader !== `Bearer ${process.env.ALERT_CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const ebayToken = await getEbayToken();

    const { data: alerts, error: alertsError } = await supabase
      .from("notified_searches")
      .select("*")
      .eq("is_active", true);

    if (alertsError) {
      return res.status(500).json({ error: alertsError.message });
    }

    const processed = [];
    const userDigestMap = new Map();

    for (const alert of alerts) {
      const alertDebug = {
        alert_id: alert.id,
        query: alert.query,
        user_id: alert.user_id,
        user_email: null,
        plan: null,
        new_items_found: 0,
        email_attempted: false,
        email_sent: false,
        email_error: null,
        seen_items_inserted: 0,
        skipped_reason: null,
        source_counts: {
          ebay: 0,
          yahoo: 0,
          upgarage: 0
        }
      };

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, email, plan")
        .eq("id", alert.user_id)
        .single();

      if (profileError || !profile) {
        alertDebug.skipped_reason = "profile_not_found";
        processed.push(alertDebug);
        continue;
      }

      alertDebug.user_email = profile.email;
      alertDebug.plan = profile.plan;

      if (profile.plan !== "builder" && profile.plan !== "collector") {
        alertDebug.skipped_reason = "user_not_on_paid_plan";
        processed.push(alertDebug);
        continue;
      }

      const newItems = [];

      // eBay
      try {
        const ebayItems = await searchEbaySmart(alert.query, ebayToken);
        for (const item of ebayItems) {
          const seenId = `ebay:${item.itemId || item.item_id || item.item_url}`;
          const alreadySeen = await hasSeenItem(supabase, alert.id, seenId);
          if (alreadySeen) continue;

          newItems.push({
            source: "eBay",
            seen_id: seenId,
            title: item.display_title || item.title || "Untitled listing",
            hint: item.english_hint || "",
            itemWebUrl: addAffiliateParams(item.item_url || item.itemWebUrl || ""),
            imageUrl: item.image_url || item.imageUrl || item.image?.imageUrl || "",
            price: item.price || "Price not available"
          });

          alertDebug.source_counts.ebay += 1;
        }
      } catch (e) {
        // keep going
      }

      // Yahoo Auctions
      try {
        const yahooItems = await searchYahooAuctionsSmart(alert.query);
        for (const item of yahooItems) {
          const seenId = `yahoo:${item.itemId || item.item_id || item.item_url}`;
          const alreadySeen = await hasSeenItem(supabase, alert.id, seenId);
          if (alreadySeen) continue;

          newItems.push({
            source: "Yahoo Auctions",
            seen_id: seenId,
            title: item.display_title || item.title || "Untitled listing",
            hint: item.english_hint || "",
            itemWebUrl: item.item_url || "",
            imageUrl: item.image_url || "",
            price: item.price || "Price not available"
          });

          alertDebug.source_counts.yahoo += 1;
        }
      } catch (e) {
        // keep going
      }

      // Up Garage
      try {
        const upgarageItems = await searchUpGarageSmart(alert.query);
        for (const item of upgarageItems) {
          const seenId = `upgarage:${item.itemId || item.item_id || item.item_url}`;
          const alreadySeen = await hasSeenItem(supabase, alert.id, seenId);
          if (alreadySeen) continue;

          newItems.push({
            source: "Up Garage",
            seen_id: seenId,
            title: item.display_title || item.title || "Untitled listing",
            hint: item.english_hint || "",
            itemWebUrl: item.item_url || "",
            imageUrl: item.image_url || "",
            price: item.price || "Price not available"
          });

          alertDebug.source_counts.upgarage += 1;
        }
      } catch (e) {
        // keep going
      }

      if (!newItems.length) {
        alertDebug.skipped_reason = "no_new_items";
        processed.push(alertDebug);
        continue;
      }

      alertDebug.new_items_found = newItems.length;

      if (!userDigestMap.has(profile.email)) {
        userDigestMap.set(profile.email, {
          user_email: profile.email,
          alerts: []
        });
      }

      userDigestMap.get(profile.email).alerts.push({
        alert_id: alert.id,
        query: alert.query,
        items: newItems
      });

      processed.push(alertDebug);
    }

    for (const [, digest] of userDigestMap) {
      try {
        await sendDigestEmail(digest.user_email, digest.alerts);

        for (const alertGroup of digest.alerts) {
          for (const item of alertGroup.items) {
            await supabase
              .from("seen_alert_items")
              .insert([
                {
                  notified_search_id: alertGroup.alert_id,
                  external_item_id: item.seen_id
                }
              ]);
          }
        }

        for (const row of processed) {
          if (row.user_email === digest.user_email && row.new_items_found > 0) {
            row.email_attempted = true;
            row.email_sent = true;
            row.seen_items_inserted = row.new_items_found;
          }
        }
      } catch (emailError) {
        for (const row of processed) {
          if (row.user_email === digest.user_email && row.new_items_found > 0) {
            row.email_attempted = true;
            row.email_sent = false;
            row.email_error = String(emailError);
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      processed_count: processed.length,
      processed
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to check alerts",
      details: String(error)
    });
  }
};

async function hasSeenItem(supabase, alertId, seenId) {
  const { data } = await supabase
    .from("seen_alert_items")
    .select("id")
    .eq("notified_search_id", alertId)
    .eq("external_item_id", seenId)
    .maybeSingle();

  return !!data;
}

async function getEbayToken() {
  const auth = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString("base64");

  const tokenRes = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${auth}`
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope"
  });

  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    throw new Error("Could not get eBay token");
  }

  return tokenData.access_token;
}

async function buildSearchTerms(query) {
  const plan = await buildSmartSearchQueries({ query });
  const terms = [query, ...(plan.alternate_queries || [])]
    .map((q) => String(q || "").trim())
    .filter(Boolean);

  return Array.from(new Set(terms.map((q) => q.toLowerCase()))).map((lowered) => {
    return terms.find((t) => t.toLowerCase() === lowered);
  });
}

async function searchEbaySmart(query, accessToken) {
  const searchTerms = await buildSearchTerms(query);

  const resultSets = await Promise.all(
    searchTerms.map(async (term) => {
      const searchRes = await fetch(
        `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(term)}&limit=6`,
        {
          headers: {
            "Authorization": `Bearer ${accessToken}`
          }
        }
      );

      const data = await searchRes.json();
      return Array.isArray(data.itemSummaries) ? data.itemSummaries : [];
    })
  );

  const rawItems = dedupeByKey(
    resultSets.flat().map((item) => ({
      itemId: item.itemId || item.itemWebUrl || "",
      title: item.title || "Untitled listing",
      item_url: item.itemWebUrl || "",
      image_url: item.image?.imageUrl || "",
      price: item.price ? `${item.price.value} ${item.price.currency}` : "Price not available",
      marketplace: "eBay"
    })),
    (item) => item.itemId || item.item_url
  ).slice(0, 12);

  return normalizeListings({
    source: "eBay",
    query,
    items: rawItems,
    shouldNormalize: true
  });
}

async function searchUpGarageSmart(query) {
  const searchTerms = await buildSearchTerms(query);

  const resultSets = await Promise.all(
    searchTerms.map((term) => fetchUpGarageSearch(term).catch(() => []))
  );

  const rawItems = dedupeByKey(
    resultSets.flat(),
    (item) => item.itemId || item.item_url
  ).slice(0, 12);

  return normalizeListings({
    source: "Up Garage",
    query,
    items: rawItems,
    shouldNormalize: true
  });
}

async function fetchUpGarageSearch(query) {
  const apiUrl =
    `https://www.upgarage.com/service/api/v1/items` +
    `?dd_bunrui_cd=01` +
    `&search_word=${encodeURIComponent(query)}` +
    `&order_by=arrival_date` +
    `&sort_order=desc` +
    `&limit=6` +
    `&offset=0` +
    `&view_type=tile` +
    `&lang=en`;

  const response = await fetch(apiUrl, {
    headers: {
      ...DEFAULT_HEADERS,
      "Accept": "application/json"
    }
  });

  const data = await response.json();
  const rawItems = Array.isArray(data?.resources) ? data.resources : [];

  return rawItems.map((item) => ({
    itemId: item.id,
    title: cleanText(item.name || "Untitled listing"),
    item_url: item.id ? `https://www.upgarage.com/en/ec/item/${item.id}/` : "#",
    image_url: item.image_url || "",
    price: item.tax_included_price
      ? `¥${Number(item.tax_included_price).toLocaleString("en-US")}`
      : item.price
      ? `¥${Number(item.price).toLocaleString("en-US")}`
      : "Price not available",
    marketplace: "Up Garage",
    shop_name: item.shop_name || "",
    category: item.s_bunrui_name || ""
  }));
}

async function searchYahooAuctionsSmart(query) {
  const searchTerms = await buildSearchTerms(query);

  const baseItems = await searchYahooAuctionsSingle(query).catch(() => []);
  const alternateTerms = searchTerms.filter((term) => term.toLowerCase() !== query.toLowerCase());

  let alternateItems = [];
  if (alternateTerms.length) {
    const alternateResultSets = await Promise.all(
      alternateTerms.map((term) => searchYahooAuctionsSingle(term).catch(() => []))
    );
    alternateItems = alternateResultSets.flat();
  }

  const rawItems = dedupeByKey(
    [...baseItems, ...alternateItems],
    (item) => item.itemId || item.item_url
  ).slice(0, 12);

  return normalizeListings({
    source: "Yahoo Auctions",
    query,
    items: rawItems,
    shouldNormalize: true
  });
}

async function searchYahooAuctionsSingle(query) {
  const searchUrl = `https://auctions.yahoo.co.jp/search/search/${encodeURIComponent(query)}/0/`;

  const response = await fetch(searchUrl, {
    headers: {
      ...DEFAULT_HEADERS,
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
    }
  });

  const html = await response.text();
  const itemUrls = extractYahooItemUrls(html).slice(0, 6);

  const itemResults = await Promise.all(
    itemUrls.map(async (url) => {
      try {
        return await fetchYahooAuctionItem(url);
      } catch {
        return null;
      }
    })
  );

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
    headers: {
      ...DEFAULT_HEADERS,
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
    }
  });

  const html = await response.text();
  const $ = cheerio.load(html);
  const bodyText = cleanText($("body").text());

  const itemId = itemUrl.split("/").pop();

  return {
    itemId,
    title: cleanTitle(
      $('meta[property="og:title"]').attr("content") ||
      $("title").text().trim() ||
      ""
    ),
    item_url: itemUrl,
    image_url:
      $('meta[property="og:image"]').attr("content") ||
      $("img").first().attr("src") ||
      "",
    price: formatYahooPrice(extractPrice(bodyText)) || "Price not available",
    marketplace: "Yahoo Auctions"
  };
}

function addAffiliateParams(rawLink) {
  if (!rawLink) return "";
  return (
    rawLink +
    (rawLink.includes("?") ? "&" : "?") +
    "mkcid=1&mkrid=711-53200-19255-0&siteid=0&campid=5339144348&customid=&toolid=10001&mkevt=1"
  );
}

async function sendDigestEmail(toEmail, alertGroups) {
  const totalNewItems = alertGroups.reduce((sum, group) => sum + group.items.length, 0);

  const subject =
    totalNewItems === 1
      ? `1 new Stray Parts match`
      : `${totalNewItems} new Stray Parts matches`;

  const groupedHtml = alertGroups
    .map((group) => {
      const itemsHtml = group.items
        .slice(0, 8)
        .map(
          (item) => `
            <div style="margin-bottom:20px;padding:18px;border:1px solid #e5e1d5;border-radius:14px;background:#faf8f2;">
              ${item.imageUrl ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title)}" style="max-width:140px;border-radius:10px;display:block;margin-bottom:12px;">` : ""}
              <div style="font-size:12px;color:#777;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.6px;">
                ${escapeHtml(item.source)}
              </div>
              <div style="font-size:18px;line-height:1.4;font-weight:bold;color:#222;margin-bottom:8px;">
                ${escapeHtml(item.title)}
              </div>
              ${item.hint ? `<div style="font-size:14px;color:#666;line-height:1.5;margin-bottom:8px;">${escapeHtml(item.hint)}</div>` : ""}
              <div style="font-size:16px;font-weight:bold;color:#222;margin-bottom:12px;">
                ${escapeHtml(item.price || "Price not available")}
              </div>
              <a href="${item.itemWebUrl}" style="display:inline-block;padding:12px 18px;background:#a42a0e;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">
                View Listing
              </a>
            </div>
          `
        )
        .join("");

      return `
        <div style="margin-bottom:34px;">
          <h2 style="font-size:20px;line-height:1.3;margin:0 0 8px;color:#222;">${escapeHtml(group.query)}</h2>
          <p style="font-size:14px;color:#666;margin:0 0 16px;">${group.items.length} new match${group.items.length === 1 ? "" : "es"}</p>
          ${itemsHtml}
        </div>
      `;
    })
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;background:#ede8d0;padding:32px 16px;color:#222;">
      <div style="max-width:720px;margin:0 auto;background:#fffaf0;border-radius:18px;padding:32px;border:1px solid #ddd6bf;">
        <div style="text-align:center;margin-bottom:24px;">
          <h1 style="margin:0 0 10px;font-size:30px;line-height:1.1;color:#222;">Stray Parts Alerts</h1>
          <p style="margin:0;color:#666;font-size:15px;">New matches have been found for your notified searches.</p>
        </div>

        <div style="margin-top:24px;">
          ${groupedHtml}
        </div>

        <p style="margin-top:30px;color:#777;font-size:14px;line-height:1.6;">
          You’re receiving this email because you created notified searches on Stray Parts.
        </p>
      </div>
    </div>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "Stray Parts Alerts <alerts@mail.strayparts.io>",
      to: toEmail,
      subject,
      html
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Resend error: ${JSON.stringify(data)}`);
  }

  return data;
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

function dedupeByKey(items, keyFn) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;

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

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
