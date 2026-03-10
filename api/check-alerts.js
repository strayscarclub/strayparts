const { createClient } = require("@supabase/supabase-js");

module.exports = async function handler(req, res) {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const ebayToken = await getEbayToken();

    const { data: alerts, error: alertsError } = await supabase
      .from("notified_searches")
      .select(`
        id,
        query,
        is_active,
        user_id,
        profiles!inner (
          id,
          email,
          plan
        )
      `)
      .eq("is_active", true);

    if (alertsError) {
      return res.status(500).json({ error: alertsError.message });
    }

    const processed = [];

    for (const alert of alerts) {
      const profile = Array.isArray(alert.profiles) ? alert.profiles[0] : alert.profiles;

      if (!profile) continue;
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
            itemWebUrl: item.itemWebUrl || "",
            imageUrl: item.image?.imageUrl || "",
            price: item.price ? `${item.price.value} ${item.price.currency}` : "Price not available"
          });
        }
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
