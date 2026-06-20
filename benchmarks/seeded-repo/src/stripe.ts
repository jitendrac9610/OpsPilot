import express from "express";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "mock_key");
const router = express.Router();

// Middleware: Express json parser (parses raw body into JSON object)
router.use(express.json());

// FAILURE 6: Stripe webhook raw-body verify failure
// Stripe requires the raw buffer to verify webhook signature, but here we pass req.body (which is already parsed to JSON)
router.post("/webhook", (req, res) => {
  const sig = req.headers["stripe-signature"] || "";
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || "mock_secret";

  try {
    // This will FAIL because req.body is a parsed JSON object, not a raw buffer
    const event = stripe.webhooks.constructEvent(
      req.body, // Should be req.rawBody or raw buffer
      sig,
      endpointSecret
    );
    res.status(200).send(`Event received: ${event.id}`);
  } catch (err: any) {
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

export const stripeWebhookRouter = router;
