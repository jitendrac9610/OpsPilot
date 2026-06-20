import express from "express";
import { getUserData } from "./db.js";
import { addInterviewJob } from "./queue.js";
import { sendInterviewCreatedEvent } from "./inngest.js";
import { stripeWebhookRouter } from "./stripe.js";
import { clerkRouter } from "./clerk.js";
import { generateGetStreamToken, triggerMemoryCrash, processWebhookNotIdempotent } from "./failures.js";

const app = express();
const port = process.env.PORT || 8080;

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

// Postgres endpoint (with connection leak)
app.get("/users/:id", async (req, res) => {
  try {
    const user = await getUserData(req.params.id);
    res.status(200).json(user);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// BullMQ job publisher (with Redis hostname/queue mismatch)
app.post("/interviews", async (req, res) => {
  try {
    const { interviewId } = req.query;
    await addInterviewJob(String(interviewId));
    res.status(201).json({ status: "queued", interviewId });
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// Inngest publisher (with event name mismatch)
app.post("/inngest/event", async (req, res) => {
  try {
    const { interviewId } = req.query;
    await sendInterviewCreatedEvent(String(interviewId));
    res.status(201).json({ status: "event_published" });
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// Webhook endpoints
app.use("/stripe", stripeWebhookRouter);
app.use("/clerk", clerkRouter);

// GetStream endpoint (with identity mismatch)
app.get("/stream-token", (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).send("userId required");
  const payload = generateGetStreamToken(String(userId));
  res.status(200).json(payload);
});

// Memory trigger endpoint
app.post("/crash/memory", (req, res) => {
  triggerMemoryCrash();
  res.status(202).send("Memory crash triggered. Server will die soon.");
});

// Webhook duplication endpoint (non-idempotent)
app.post("/webhook/charge", async (req, res) => {
  const { eventId, amount } = req.body;
  const result = await processWebhookNotIdempotent(eventId, Number(amount));
  res.status(200).json(result);
});

app.listen(port, () => {
  console.log(`Seeded benchmark server running on port ${port}`);
});
