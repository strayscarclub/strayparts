const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    }

    if (!process.env.STRIPE_PRICE_ID_BUILDER) {
      return res.status(500).json({ error: "Missing STRIPE_PRICE_ID_BUILDER" });
    }

    if (!process.env.SITE_URL) {
      return res.status(500).json({ error: "Missing SITE_URL" });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const { plan, userId, email } = req.body || {};

    if (!plan || !userId || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (plan !== "builder") {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const priceId = process.env.STRIPE_PRICE_ID_BUILDER;

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single();

    if (profileError) {
      return res.status(500).json({
        error: "Could not load user profile",
        details: profileError.message
      });
    }

    let customerId = profile?.stripe_customer_id || null;

    if (customerId) {
      try {
        const existingCustomer = await stripe.customers.retrieve(customerId);
        if (existingCustomer.deleted) {
          customerId = null;
        }
      } catch (err) {
        if (err.code === "resource_missing") {
          customerId = null;
        } else {
          throw err;
        }
      }
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: {
          supabase_user_id: userId
        }
      });

      customerId = customer.id;

      const { error: updateError } = await supabase
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", userId);

      if (updateError) {
        return res.status(500).json({
          error: "Could not save Stripe customer ID",
          details: updateError.message
        });
      }
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
      subscription_data: {
        trial_period_days: 30
      },
      success_url: `${process.env.SITE_URL}/my-garage.html?success=1`,
      cancel_url: `${process.env.SITE_URL}/pricing.html?canceled=1`,
      allow_promotion_codes: true,
      metadata: {
        supabase_user_id: userId,
        selected_plan: "builder"
      }
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to create checkout session",
      details: error.message || String(error)
    });
  }
};
