const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { userId } = req.body || {};

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single();

    if (error || !profile?.stripe_customer_id) {
      return res.status(400).json({ error: "No Stripe customer found" });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.SITE_URL}/pricing.html`
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to create portal session",
      details: String(error)
    });
  }
};
