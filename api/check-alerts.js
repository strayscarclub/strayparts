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
    const userDigestMap = new Map();

    for (const alert of alerts) {
      const alertDebug = {
        alert_id: alert.id,
        query: alert.query,
        user_id: alert.user_id,
        user_email: null,
        plan: null,
        ebay_results_count: 0,
        unseen_items_count: 0,
        email_attempted: false,
        email_sent: false,
        email_error: null,
        seen_items_inserted: 0,
        skipped_reason: null,
        new_items: []
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

      const ebayResults = await searchEbay(alert.query, ebayToken);
      const itemSummaries = ebayResults.itemSummaries || [];
      alertDebug.ebay_results_count = itemSummaries.length;

      const newItems = [];

      for (const item of itemSummaries) {
        const externalItemId = item.itemId || item.legacyItemId || item.itemWebUrl;
        if (!externalItemId) continue;

        const { data: existingSeen, error: seenCheckError } = await supabase
          .from("seen_alert_items")
          .select("id")
          .eq("notified_search_id", alert.id)
          .eq("external_item_id", externalItemId)
          .maybeSingle();

        if (seenCheckError) continue;
        if (existingSeen) continue;

        newItems.push({
          title: item.title || "Untitled listing",
          itemId: externalItemId,
          itemWebUrl: addAffiliateParams(item.itemWebUrl || ""),
          imageUrl: item.image?.imageUrl || "",
          price: item.price ? `${item.price.value} ${item.price.currency}` : "Price not available"
        });
      }

      alertDebug.unseen_items_count = newItems.length;
      alertDebug.new_items = newItems;

      if (newItems.length === 0) {
        alertDebug.skipped_reason = "no_new_items";
        processed.push(alertDebug);
        continue;
      }

      if (!userDigestMap.has(profile.email)) {
        userDigestMap.set(profile.email, {
          user_email: profile.email,
          user_id: profile.id,
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
                  external_item_id: item.itemId
                }
              ]);
          }
        }

        for (const row of processed) {
          if (row.user_email === digest.user_email && row.unseen_items_count > 0) {
            row.email_attempted = true;
            row.email_sent = true;
            row.seen_items_inserted = row.unseen_items_count;
          }
        }
      } catch (emailError) {
        for (const row of processed) {
          if (row.user_email === digest.user_email && row.unseen_items_count > 0) {
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
    `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=12`,
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

async function sendDigestEmail(toEmail, alertGroups) {
  const totalNewItems = alertGroups.reduce((sum, group) => sum + group.items.length, 0);

  const subject =
    totalNewItems === 1
      ? `1 new Stray Parts match`
      : `${totalNewItems} new Stray Parts matches`;

  const groupedHtml = alertGroups
    .map((group) => {
      const itemsHtml = group.items
        .slice(0, 5)
        .map(
          (item) => `
            <div style="margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid #ddd;">
              ${item.imageUrl ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title)}" style="max-width:140px;border-radius:8px;display:block;margin-bottom:10px;">` : ""}
              <h4 style="margin:0 0 8px 0;">${escapeHtml(item.title)}</h4>
              <p style="margin:0 0 8px 0;color:#555;"><strong>Price:</strong> ${escapeHtml(item.price)}</p>
              <p style="margin:0;">
                <a href="${item.itemWebUrl}" style="color:#a42a0e;font-weight:bold;">View on eBay</a>
              </p>
            </div>
          `
        )
        .join("");

      return `
        <div style="margin-bottom:32px;">
          <h2 style="color:#222;margin-bottom:10px;">${escapeHtml(group.query)}</h2>
          ${itemsHtml}
        </div>
      `;
    })
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px;">
      <h1 style="color:#222;">New matches on Stray Parts</h1>
      <p style="color:#555;">We found new listings across your notified searches.</p>
      <div style="margin-top:24px;">
        ${groupedHtml}
      </div>
      <p style="margin-top:30px;color:#777;font-size:14px;">
        You’re receiving this email because you created notified searches on Stray Parts.
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
