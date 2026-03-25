const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  try {
    const sig = req.headers["stripe-signature"];
    const rawBody = await getRawBody(req);

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.mode === "subscription") {
        const userId = session.metadata?.supabase_user_id || null;
        const subscriptionId = session.subscription || null;
        const customerId = session.customer || null;
        const plan = session.metadata?.selected_plan || "free";

        if (userId) {
          await supabase
            .from("profiles")
            .update({
              plan,
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId
            })
            .eq("id", userId);
        }
      }
    }

    if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      const status = subscription.status;

      let nextPlan = "free";
      if (status === "active" || status === "trialing" || status === "past_due") {
        // keep current paid plan if possible
        const { data: profile } = await supabase
          .from("profiles")
          .select("plan")
          .eq("stripe_customer_id", customerId)
          .single();

        if (status === "active" || status === "trialing" || status === "past_due") {
  nextPlan = "builder";
}
      }

      if (event.type === "customer.subscription.deleted") {
        nextPlan = "free";
      }

      await supabase
        .from("profiles")
        .update({
          plan: nextPlan,
          stripe_subscription_id:
            event.type === "customer.subscription.deleted"
              ? null
              : subscription.id
        })
        .eq("stripe_customer_id", customerId);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    return res.status(500).send(String(error));
  }
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
