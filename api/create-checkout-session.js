const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { plan, userId, email } = req.body || {};

    if (!plan || !userId || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const priceId =
      plan === "builder"
        ? process.env.STRIPE_PRICE_ID_BUILDER
        : plan === "collector"
        ? process.env.STRIPE_PRICE_ID_COLLECTOR
        : null;

    if (!priceId) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single();

    let customerId = profile?.stripe_customer_id || null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: {
          supabase_user_id: userId
        }
      });

      customerId = customer.id;

      await supabase
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", userId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      success_url: `${process.env.SITE_URL}/pricing.html?success=1`,
      cancel_url: `${process.env.SITE_URL}/pricing.html?canceled=1`,
      allow_promotion_codes: true,
      metadata: {
        supabase_user_id: userId,
        selected_plan: plan
      }
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to create checkout session",
      details: String(error)
    });
  }
};
