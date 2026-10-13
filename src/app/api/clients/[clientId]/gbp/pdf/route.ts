import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { clients } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { latestGbpPacksForClient } from "@/lib/services/gbp-packs";
import { renderGbpPacksPdf, gbpPdfFilename } from "@/lib/services/gbp-pdf";

// S4 — printable pack card: one PDF page per pack, rendered from the STORED
// payloads (never recomputed). Admin-session auth; empty pack set → 404 (an
// expected "nothing built yet" state, not an error).

export async function GET(
  _request: Request,
  { params }: { params: { clientId: string } },
) {
  await requireAdmin();
  const [client] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, params.clientId))
    .limit(1);
  if (!client) return new Response("Client not found", { status: 404 });
  const packs = await latestGbpPacksForClient(params.clientId);
  if (packs.length === 0) {
    return new Response("No GBP packs built yet — build them in the tab first.", { status: 404 });
  }
  const buffer = await renderGbpPacksPdf({
    clientName: client.name,
    packs: packs.map((p) => ({ assetType: p.assetType, payload: p.payload, createdAt: p.createdAt })),
  });
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${gbpPdfFilename(params.clientId)}"`,
    },
  });
}