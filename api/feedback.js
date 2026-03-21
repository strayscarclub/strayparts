import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { name = "", email = "", type = "other", message = "" } = req.body || {};

    if (!message.trim()) {
      return res.status(400).json({ error: "Feedback message is required." });
    }

    const safeName = String(name).trim();
    const safeEmail = String(email).trim();
    const safeType = String(type).trim();
    const safeMessage = String(message).trim();

    await resend.emails.send({
      from: "Stray Parts <onboarding@resend.dev>",
      to: "contact@strayparts.io",
      subject: `New Stray Parts feedback: ${safeType}`,
      reply_to: safeEmail || undefined,
      text: [
        `Feedback Type: ${safeType}`,
        `Name: ${safeName || "Not provided"}`,
        `Email: ${safeEmail || "Not provided"}`,
        "",
        "Message:",
        safeMessage
      ].join("\n")
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Feedback API error:", error);
    return res.status(500).json({ error: "Failed to send feedback." });
  }
}
