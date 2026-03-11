const { createClient } = require("@supabase/supabase-js");

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

    for (const alert of alerts) {
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, email, plan")
        .eq("id", alert.user_id)
        .single();

      if (profileError || !profile) continue;
      if (profile.plan !== "builder" && profile.plan !== "collector") continue;

      const ebayResults = await searchEbay(alert.query, ebayToken);
      const itemSummaries = ebayResults.itemSummaries || [];
      const newItems = [];

      for (const item of itemSummaries) {
        const externalItemId = item.itemId || item.legacyItemId || item.itemWebUrl;
        if (!externalItemId) continue;

        const { data: existingSeen } = await supabase
          .from("seen_alert_items")
          .select("id")
          .eq("notified_search_id", alert.id)
          .eq("external_item_id", externalItemId)
          .maybeSingle();

        if (existingSeen) continue;

        const { error: insertSeenError } = await supabase
          .from("seen_alert_items")
          .insert([
            {
              notified_search_id: alert.id,
              external_item_id: externalItemId
            }
          ]);

        if (!insertSeenError) {
          newItems.push({
            title: item.title || "Untitled listing",
            itemId: externalItemId,
            itemWebUrl: addAffiliateParams(item.itemWebUrl || ""),
            imageUrl: item.image?.imageUrl || "",
            price: item.price ? `${item.price.value} ${item.price.currency}` : "Price not available"
          });
        }
      }

      if (newItems.length > 0) {
        await sendAlertEmail(profile.email, alert.query, newItems);
      }

      processed.push({
        alert_id: alert.id,
        query: alert.query,
        user_email: profile.email,
        new_items_found: newItems.length,
        new_items: newItems
      });
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

async function searchEbay(query, accessToken) {
  const searchRes = await fetch(
    `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=20`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`
      }
    }
  );

  return await searchRes.json();
}

function addAffiliateParams(rawLink) {
  if (!rawLink) return "";
  return (
    rawLink +
    (rawLink.includes("?") ? "&" : "?") +
    "mkcid=1&mkrid=711-53200-19255-0&siteid=0&campid=5339144348&customid=&toolid=10001&mkevt=1"
  );
}

async function sendAlertEmail(toEmail, query, items) {
  const subject =
    items.length === 1
      ? `New Stray Parts match for "${query}"`
      : `${items.length} new Stray Parts matches for "${query}"`;

  const itemsHtml = items
    .slice(0, 5)
    .map(
      (item) => `
        <div style="margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid #ddd;">
          ${item.imageUrl ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title)}" style="max-width:140px;border-radius:8px;display:block;margin-bottom:10px;">` : ""}
          <h3 style="margin:0 0 8px 0;">${escapeHtml(item.title)}</h3>
          <p style="margin:0 0 8px 0;color:#555;"><strong>Price:</strong> ${escapeHtml(item.price)}</p>
          <p style="margin:0;">
            <a href="${item.itemWebUrl}" style="color:#a42a0e;font-weight:bold;">View on eBay</a>
          </p>
        </div>
      `
    )
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px;">
      <h1 style="color:#222;">New listing match on Stray Parts</h1>
      <p style="color:#555;">We found new results for your notified search:</p>
      <p style="font-size:18px;font-weight:bold;color:#222;">${escapeHtml(query)}</p>
      <div style="margin-top:24px;">
        ${itemsHtml}
      </div>
      <p style="margin-top:30px;color:#777;font-size:14px;">
        You’re receiving this email because you created a notified search on Stray Parts.
      </p>
    </div>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "delivered@resend.dev",
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

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
