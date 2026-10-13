import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

/**
 * Reply auth for 396red. Separate from MARKETING_API_KEY on purpose: a key
 * that can list leads must not be able to post a message into a client thread.
 *
 * OPS_API_KEY is env-only. It is not stored in app_settings and it is not
 * shown in the Integrations UI, so generating a marketing key cannot mint it.
 */

function presentedKey(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const x = request.headers.get("x-api-key");
  if (x) return x.trim();
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function opsAuthGuard(request: Request): NextResponse | null {
  const expected = process.env.OPS_API_KEY?.trim();
  if (!expected) {
    return NextResponse.json(
      { error: "API not configured", detail: "OPS_API_KEY is not set on the web service." },
      { status: 503 },
    );
  }
  const got = presentedKey(request);
  if (!got || !safeEqual(got, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
