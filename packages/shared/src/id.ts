import { randomBytes } from "crypto";

export function generateId(prefix?: string): string {
  const bytes = randomBytes(16);
  const id = bytes.toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

export function generateCorrelationId(): string {
  return generateId("corr");
}

export function generateIdempotencyKey(): string {
  return generateId("idem");
}
