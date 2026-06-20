import express from "express";
import { sessions } from "@clerk/clerk-sdk-node";

const router = express.Router();

// FAILURE 7: Clerk token-forwarding failure
// The client auth token is in Authorization header, but backend tries to verify it
// directly without stripping the "Bearer " prefix, leading to a verification error.
router.get("/profile", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send("No authorization header");
  }

  try {
    // Verification expects the token string, e.g. "sess_abc123"
    // Passing "Bearer sess_abc123" directly causes verification to fail!
    const sessionToken = authHeader; // Forgot to do .replace("Bearer ", "")!
    const session = await sessions.verifySession(sessionToken, "mock_session_id");
    res.status(200).json({ user: session.userId });
  } catch (err: any) {
    res.status(401).send(`Auth Verification Failed: ${err.message}`);
  }
});

export const clerkRouter = router;
