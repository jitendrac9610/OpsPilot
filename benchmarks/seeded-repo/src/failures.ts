import { StreamChat } from "getstream";
import express from "express";

// ==========================================================
// FAILURE 8: GetStream identity mismatch
// ==========================================================
// The backend generates a token for user ID "john-doe", but passes it to a client 
// trying to connect as "john_doe" (mismatched underscore vs hyphen).
export function generateGetStreamToken(userId: string) {
  const apiKey = process.env.GETSTREAM_API_KEY || "mock_key";
  const apiSecret = process.env.GETSTREAM_API_SECRET || "mock_secret";
  
  // Backend client
  const serverClient = StreamChat.getInstance(apiKey, apiSecret);
  
  // Leaks a mismatch: if userId is "john_doe", it might sign for "john-doe"
  const normalizedId = userId.replace("_", "-"); 
  return {
    userId, // john_doe
    token: serverClient.createToken(normalizedId) // signs john-doe
  };
}

// ==========================================================
// FAILURE 9: Kubernetes readiness failure (mock indicator)
// ==========================================================
// Readiness probe checks /health/ready. If db is not connected, it throws, 
// but here we have a probe that checks a port that the app doesn't listen on 
// or returns 500 when it should be 200 due to local caching issues.
export const KUBERNETES_READINESS_METADATA = {
  containerPort: 8080,
  probePath: "/health/ready",
  failureReason: "Probe checks port 8081 instead of 8080 in deployment.yaml config"
};

// ==========================================================
// FAILURE 10: Memory-limit crash
// ==========================================================
// Triggering an out-of-memory error by appending to a global array infinitely.
const leakMemoryArray: Buffer[] = [];
export function triggerMemoryCrash() {
  setInterval(() => {
    // Allocates 10MB chunks infinitely until OOM
    leakMemoryArray.push(Buffer.alloc(10 * 1024 * 1024));
  }, 100);
}

// ==========================================================
// FAILURE 11: Duplicate webhook
// ==========================================================
// A webhook endpoint that is not idempotent. Processing the same event twice
// creates duplicate database entries or duplicate charges.
const processedEvents = new Set<string>();

export async function processWebhookNotIdempotent(eventId: string, paymentAmount: number) {
  // FAILURE: Lacks "if (processedEvents.has(eventId)) return;" idempotency check
  // This will duplicate the transaction!
  processedEvents.add(eventId); 
  return { status: "processed", amount: paymentAmount, duplicate: processedEvents.has(eventId) };
}

// ==========================================================
// FAILURE 12: Retry storm
// ==========================================================
// If a service call fails, retrying immediately without exponential backoff
// or jitter, causing a retry storm (DDoS on our own backend).
export async function callExternalProviderWithRetryStorm(fn: () => Promise<any>) {
  let attempts = 0;
  while (attempts < 10) {
    try {
      return await fn();
    } catch (err) {
      attempts++;
      // FAILURE: Retries immediately without backoff/jitter!
    }
  }
  throw new Error("Failed after 10 immediate retries");
}

// ==========================================================
// FAILURE 13: Frontend/backend contract mismatch
// ==========================================================
// The backend returns user profile under camelCase key `avatarUrl`
// but the frontend expects snake_case `avatar_url`.
export function getBackendProfileResponse() {
  return {
    id: "usr_123",
    username: "dev_pilot",
    avatarUrl: "https://example.com/avatar.png" // camelCase!
  };
}

// ==========================================================
// FAILURE 14: CodeMirror listener leak
// ==========================================================
// Every time a React component re-renders, it attaches a new scroll listener 
// to CodeMirror without cleaning up the old one, leading to memory leaks and lag.
export class CodeMirrorScrollListenerMock {
  private listeners: (() => void)[] = [];
  
  public attachListener(editor: any, callback: () => void) {
    // FAILURE: Registers callback every re-render without cleaning up previous ones!
    this.listeners.push(callback);
    editor.on("scroll", callback);
  }
}
