/**
 * Authentication helpers for the dispatch handler.
 *
 * Inbound (Cronvello → app): a bearer token equal to the configured `dispatchSecret`.
 * We compare it in constant time to avoid leaking the secret through timing.
 *
 * Outbound (app → Cronvello, async_callback only): we sign the callback body with
 * HMAC-SHA256 (`sha256=<hex>`), matching Cronvello's callback signature format.
 */

const encoder = new TextEncoder();

/** Parse `Authorization: Bearer <token>` (scheme is case-insensitive). Returns the token or null. */
export function parseBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^bearer\s+(.+)$/i.exec(headerValue.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Constant-time string comparison. Runs in time proportional to the longer input and never
 * short-circuits, so it does not reveal where two values diverge. No `node:crypto` dependency,
 * so it works on edge runtimes too.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * HMAC-SHA256 signature in Cronvello's wire format: `sha256=<hex>`.
 * Uses WebCrypto (`crypto.subtle`), a global on Node 20+ and edge runtimes — no node:crypto.
 */
export async function signHmacSha256(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}
