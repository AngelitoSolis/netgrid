import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, opsReplyKeys } from "@/lib/db/schema";
import { opsAuthGuard } from "@/lib/api/ops-auth";
import { OPS_CONTENT_MAX, insertAdminReply, isUuid, iso } from "@/lib/api/ops-data";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/ops/threads/{clientId}/reply
 * The only write 396red is allowed. Lands in messages as sender_role=admin
 * so the client portal shows it as a normal admin reply.
 */
export async function POST(
  request: Request,
  { params }: { params: { clientId: string } },
) {
  const denied = opsAuthGuard(request);
  if (denied) return denied;
  if (!isUuid(params.clientId)) {
    return NextResponse.json({ error: "Invalid client id" }, { status: 400 });
  }

  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (key.length < 8 || key.length > 80) {
    return NextResponse.json(
      { error: "Idempotency-Key header is required (8–80 chars)" },
      { status: 400 },
    );
  }

  const [prior] = await db
    .select({ messageId: opsReplyKeys.messageId, clientId: opsReplyKeys.clientId })
    .from(opsReplyKeys)
    .where(eq(opsReplyKeys.idempotencyKey, key))
    .limit(1);
  if (prior) {
    if (prior.clientId !== params.clientId) {
      return NextResponse.json({ error: "Idempotency-Key already used" }, { status: 409 });
    }
    const [existing] = await db
      .select({
        id: messages.id,
        senderRole: messages.senderRole,
        isInternal: messages.isInternal,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.id, prior.messageId), eq(messages.clientId, params.clientId)))
      .limit(1);
    if (existing) {
      return NextResponse.json({
        id: existing.id,
        senderRole: existing.senderRole,
        isInternal: existing.isInternal ?? false,
        content: existing.content,
        createdAt: iso(existing.createdAt),
        replayed: true,
      });
    }
  }

  let body: { content?: unknown; isInternal?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }
  if (content.length > OPS_CONTENT_MAX) {
    return NextResponse.json({ error: `content exceeds ${OPS_CONTENT_MAX} characters` }, { status: 400 });
  }
  const isInternal = body.isInternal === true;

  const created = await insertAdminReply(params.clientId, content, isInternal);
  if (!created) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  await db.insert(opsReplyKeys).values({
    idempotencyKey: key,
    clientId: params.clientId,
    messageId: created.id,
  }).onConflictDoNothing();

  return NextResponse.json({ ...created, replayed: false }, { status: 201 });
}
