import { db } from "@/lib/db";
import {
  blogs,
  clients,
  messages,
  registrationLeads,
  searchPerformance,
} from "@/lib/db/schema";
import { and, asc, eq, gt, gte, sql } from "drizzle-orm";

export const OPS_CONTENT_MAX = 8000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseSince(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function listRegistrationLeads(since: Date, limit: number) {
  const rows = await db
    .select({
      id: registrationLeads.id,
      clientId: registrationLeads.clientId,
      clientName: clients.name,
      blogId: registrationLeads.blogId,
      domain: blogs.domain,
      postId: registrationLeads.postId,
      name: registrationLeads.name,
      location: registrationLeads.location,
      email: registrationLeads.email,
      referrer: registrationLeads.referrer,
      createdAt: registrationLeads.createdAt,
    })
    .from(registrationLeads)
    .innerJoin(clients, eq(registrationLeads.clientId, clients.id))
    .leftJoin(blogs, eq(registrationLeads.blogId, blogs.id))
    .where(gt(registrationLeads.createdAt, since))
    .orderBy(asc(registrationLeads.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    source: "netgrid" as const,
    kind: "registration" as const,
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    blogId: r.blogId,
    domain: r.domain,
    postId: r.postId,
    name: r.name,
    location: r.location,
    email: r.email,
    referrer: r.referrer,
    createdAt: iso(r.createdAt),
  }));
}

export async function listThreadsSince(since: Date) {
  const touched = await db
    .select({ clientId: messages.clientId })
    .from(messages)
    .where(gt(messages.createdAt, since))
    .groupBy(messages.clientId);

  const threads = [];
  for (const t of touched) {
    const [client] = await db
      .select({ name: clients.name, contactEmail: clients.contactEmail })
      .from(clients)
      .where(eq(clients.id, t.clientId))
      .limit(1);
    if (!client) continue;

    const rows = await db
      .select({
        id: messages.id,
        senderRole: messages.senderRole,
        isInternal: messages.isInternal,
        content: messages.content,
        createdAt: messages.createdAt,
        readByAdmin: messages.readByAdmin,
      })
      .from(messages)
      .where(eq(messages.clientId, t.clientId))
      .orderBy(asc(messages.createdAt))
      .limit(200);

    const last = rows[rows.length - 1];
    threads.push({
      source: "netgrid" as const,
      kind: "portal_thread" as const,
      clientId: t.clientId,
      clientName: client.name,
      contactEmail: client.contactEmail,
      unreadByAdmin: rows.filter((m) => m.readByAdmin === false).length,
      lastMessageAt: iso(last?.createdAt ?? null),
      messages: rows.map((m) => ({
        id: m.id,
        senderRole: m.senderRole,
        isInternal: m.isInternal ?? false,
        content: m.content,
        createdAt: iso(m.createdAt),
      })),
    });
  }
  return threads;
}

export async function insertAdminReply(
  clientId: string,
  content: string,
  isInternal: boolean,
) {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) return null;

  const [row] = await db
    .insert(messages)
    .values({
      clientId,
      senderId: null,
      senderRole: "admin",
      content,
      isInternal,
      readByClient: isInternal ? true : false,
      readByAdmin: true,
    })
    .returning({
      id: messages.id,
      senderRole: messages.senderRole,
      isInternal: messages.isInternal,
      content: messages.content,
      createdAt: messages.createdAt,
    });

  return {
    id: row.id,
    senderRole: row.senderRole,
    isInternal: row.isInternal ?? false,
    content: row.content,
    createdAt: iso(row.createdAt),
  };
}

export async function trafficBySite(days: number) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const rows = await db
    .select({
      blogId: blogs.id,
      domain: blogs.domain,
      clientId: blogs.clientId,
      clientName: clients.name,
      clicks: sql<number>`coalesce(sum(${searchPerformance.clicks}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${searchPerformance.impressions}), 0)::int`,
      position: sql<string | null>`
        case when coalesce(sum(${searchPerformance.impressions}), 0) > 0
          then sum(${searchPerformance.position} * ${searchPerformance.impressions})
               / sum(${searchPerformance.impressions})
          else null end`,
      syncedAt: blogs.gscLastSyncedAt,
    })
    .from(blogs)
    .innerJoin(clients, eq(blogs.clientId, clients.id))
    .leftJoin(
      searchPerformance,
      and(eq(searchPerformance.blogId, blogs.id), gte(searchPerformance.date, since)),
    )
    .where(eq(blogs.status, "active"))
    .groupBy(blogs.id, blogs.domain, blogs.clientId, clients.name, blogs.gscLastSyncedAt)
    .limit(1000);

  return rows.map((r) => ({
    blogId: r.blogId,
    domain: r.domain,
    clientId: r.clientId,
    clientName: r.clientName,
    clicks: Number(r.clicks ?? 0),
    impressions: Number(r.impressions ?? 0),
    position: r.position === null || r.position === undefined ? null : Number(r.position),
    syncedAt: iso(r.syncedAt),
  }));
}
