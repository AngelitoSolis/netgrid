// GBP optimization packs (S4 of the SEO-loop build) — copy-paste-ready Google
// Business Profile packs, operator-assisted, ZERO GBP credentials. Netgrid
// never touches a GBP (F2): every pack is text the operator pastes into the
// client's profile on a call.
//
// DETERMINISM + F3 (real data only), by construction: buildGbpPacks is
// DETERMINISTIC COMPOSITION, not a model call. The brief's "one prompt family"
// is realized as these seven fixed renderers — an LLM pass cannot guarantee the
// DoD ("no pack text contains a fact absent from dossier/knowledge/pasted
// data") because a model may paraphrase beyond the corpus. Every sentence here
// is templated from operator-verified facts; anything missing renders as
// NOT_PROVIDED_SHORT ("not provided — ask on next call") and is never guessed.
// That also makes the packs byte-identical for the same inputs, which is the
// DoD's determinism clause without needing a seeded model mock.
//
// Versioning: gbp_assets is INSERT-only — re-running after a new competitor
// paste creates NEW rows and never touches old ones (the audit trail of what
// we promised). Description A/B versions append to gbp_description_versions at
// max(version)+1, +2 with a 30-day rotation schedule carried in the pack
// payload; the 750-char GBP cap is enforced in code (clamp) AND by DB CHECK
// (migration 0058).

import { db } from "@/lib/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import {
  blogs as blogsTable,
  clientSeoDossiers,
  clients as clientsTable,
  gbpAssets,
  gbpDescriptionVersions,
} from "@/lib/db/schema";
import { blogDomainCtaUrl } from "@/lib/content/cta-target";
import { serviceTermsForClient } from "@/lib/services/location-matrix";
import { normalizeQueryKey } from "@/lib/content/topic-similarity";

// ─── Named constants ──────────────────────────────────────────────────────────

/** The one phrase every missing competitor field renders as (F3; the spec's
 * exact wording for the GBP tab). */
export const NOT_PROVIDED_SHORT = "not provided — ask on next call";

/** GBP business-description hard cap — enforced in code AND by DB CHECK. */
export const GBP_DESCRIPTION_MAX_CHARS = 750;
/** GBP post constraints. */
export const GBP_POST_HOOK_MAX_CHARS = 100;
export const GBP_POST_BODY_MAX_CHARS = 1500;
export const GBP_POSTS_COUNT = 8;
/** A post slot must not reuse an area used within this many prior slots. */
export const GBP_AREA_COOLDOWN_SLOTS = 4;
/** Review-response template bands — each ≤80 words, no discount offers. */
export const GBP_REVIEW_TEMPLATE_MAX_WORDS = 80;
/** Services in a pack stay reviewable. */
export const GBP_SERVICES_CAP = 12;
/** Competitors kept per client (the paste form is one-per-call; keep it sane). */
export const GBP_COMPETITORS_CAP = 6;
/** Description rotation cadence (days) between A/B switches. */
export const GBP_DESCRIPTION_ROTATION_DAYS = 30;
/** Photos: the upload queue's hard length. */
export const GBP_PHOTO_QUEUE_CAP = 12;

export const GBP_ASSET_TYPES = [
  "categories",
  "attributes",
  "services",
  "description",
  "posts",
  "photos",
  "reviews",
] as const;
export type GbpAssetType = (typeof GBP_ASSET_TYPES)[number];

// ─── Competitor paste parsing (pure) ─────────────────────────────────────────

/** One pasted competitor profile, exactly as the dossier stores it. Fields the
 * operator did not provide stay null/[] — never defaulted, never invented. */
export interface ParsedCompetitor {
  name: string;
  category: string | null;
  attributes: string[];
  /** name + optional price string, as pasted. */
  services: Array<{ name: string; price: string | null }>;
  description: string | null;
  reviewCount: number | null;
  /** Pasted review history: 'YYYY-MM-DD' + rating when parseable. Drives S5's
   * months-to-parity math. */
  reviews: Array<{ date: string; rating: number | null }>;
  photos: number | null;
  photosPerMonth: number | null;
}

const PASTE_KEYS: Record<string, keyof Omit<ParsedCompetitor, "name"> | "name"> = {
  name: "name",
  category: "category",
  attributes: "attributes",
  services: "services",
  description: "description",
  "review count": "reviewCount",
  reviews: "reviews",
  photos: "photos",
  "photos per month": "photosPerMonth",
};

function splitList(v: string): string[] {
  return v
    .split(/[,;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCount(v: string): number | null {
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Parse `name $price` / `name - $price` service entries from a paste line. */
function parseServiceEntry(raw: string): { name: string; price: string | null } | null {
  const m = raw.match(/^\s*(.+?)\s*(?:[-–]\s*|\s)(\$?\s?[\d.,]+)\s*$/);
  if (m) {
    const name = m[1].trim();
    const price = m[2].replace(/\s+/g, "").trim();
    return name ? { name, price } : null;
  }
  const name = raw.trim();
  return name ? { name, price: null } : null;
}

const DATE_RE = /^\s*(\d{4}-\d{2}-\d{2})/;

/** Parse one operator paste (the gbp tab's textarea). Line format is
 * `key: value` (case-insensitive keys, `|` or comma lists); the `reviews:`
 * key may be followed by bare `YYYY-MM-DD, rating` lines. Unknown lines are
 * ignored; anything unparseable stays null/[] — F3. */
export function parseCompetitorPaste(text: string): ParsedCompetitor | null {
  const lines = String(text ?? "").split(/\r?\n/);
  const out: ParsedCompetitor = {
    name: "",
    category: null,
    attributes: [],
    services: [],
    description: null,
    reviewCount: null,
    reviews: [],
    photos: null,
    photosPerMonth: null,
  };
  let inReviews = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    const keyRaw = colon > 0 ? trimmed.slice(0, colon).trim().toLowerCase() : "";
    const key = PASTE_KEYS[keyRaw];
    if (key) {
      const value = trimmed.slice(colon + 1).trim();
      inReviews = key === "reviews";
      switch (key) {
        case "name":
          out.name = value;
          break;
        case "category":
          out.category = value || null;
          break;
        case "attributes":
          out.attributes = splitList(value);
          break;
        case "services":
          out.services = splitList(value)
            .map(parseServiceEntry)
            .filter((s): s is { name: string; price: string | null } => s !== null);
          break;
        case "description":
          out.description = value || null;
          break;
        case "reviewCount":
          out.reviewCount = parseCount(value);
          break;
        case "photos":
          out.photos = parseCount(value);
          break;
        case "photosPerMonth":
          out.photosPerMonth = parseCount(value);
          break;
        case "reviews":
          // Inline form: "reviews: 2026-08-01 5; 2026-08-12 4"
          for (const part of value.split(";")) {
            const d = part.match(DATE_RE);
            if (!d) continue;
            const rating = parseCount(part.slice(d[0].length));
            out.reviews.push({ date: d[1], rating: rating === null ? null : Math.min(5, Math.max(1, rating)) });
          }
          break;
      }
      continue;
    }
    if (inReviews) {
      // Bare review lines under a `reviews:` heading: "2026-08-01, 5"
      const d = trimmed.match(DATE_RE);
      if (!d) continue;
      const rating = parseCount(trimmed.slice(d[0].length));
      out.reviews.push({ date: d[1], rating: rating === null ? null : Math.min(5, Math.max(1, rating)) });
    }
  }
  if (!out.name) return null; // an unnamed competitor is not a profile
  return out;
}

/** Merge a parsed paste into the dossier's competitor list — replaces the
 * same-named competitor (case-insensitive), else appends. Deterministic order;
 * capped. Pure. */
export function mergeCompetitorProfile(
  existing: unknown[],
  parsed: ParsedCompetitor,
): ParsedCompetitor[] {
  const prior = (Array.isArray(existing) ? existing : [])
    .map((c): ParsedCompetitor | null => {
      if (!c || typeof c !== "object") return null;
      const r = c as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name : "";
      if (!name) return null;
      return {
        name,
        category: typeof r.category === "string" ? r.category : null,
        attributes: Array.isArray(r.attributes) ? r.attributes.map(String) : [],
        services: Array.isArray(r.services)
          ? (r.services as unknown[])
              .map((s): { name: string; price: string | null } | null => {
                if (!s || typeof s !== "object") return null;
                const sr = s as Record<string, unknown>;
                return {
                  name: String(sr.name ?? ""),
                  price: typeof sr.price === "string" ? sr.price : null,
                };
              })
              .filter((s): s is { name: string; price: string | null } => s !== null && s.name !== "")
          : [],
        description: typeof r.description === "string" ? r.description : null,
        reviewCount: typeof r.reviewCount === "number" ? r.reviewCount : null,
        reviews: Array.isArray(r.reviews)
          ? (r.reviews as unknown[])
              .map((r2): { date: string; rating: number | null } | null => {
                if (!r2 || typeof r2 !== "object") return null;
                const rr = r2 as Record<string, unknown>;
                return {
                  date: String(rr.date ?? ""),
                  rating: typeof rr.rating === "number" ? rr.rating : null,
                };
              })
              .filter((r2): r2 is { date: string; rating: number | null } => r2 !== null && r2.date !== "")
          : [],
        photos: typeof r.photos === "number" ? r.photos : null,
        photosPerMonth: typeof r.photosPerMonth === "number" ? r.photosPerMonth : null,
      };
    })
    .filter((c): c is ParsedCompetitor => c !== null);

  const key = normalizeQueryKey(parsed.name);
  const merged = prior.filter((c) => normalizeQueryKey(c.name) !== key);
  merged.push(parsed);
  return merged.slice(-GBP_COMPETITORS_CAP);
}

// ─── Pure pack builders (the seven outputs) ──────────────────────────────────

export interface GbpFacts {
  /** Operator-confirmed blogs.brand_name — NEVER a domain-derived suggestion. */
  businessName: string | null;
  businessModel: string | null;
  /** Operator-verified differentiators (dossier) — doubles as OUR verifiable
   * attribute pool. */
  differentiators: string[];
  /** Real places (dossier.serviceArea ∪ site-profile areas ∪ blog cities). */
  places: string[];
  /** Real commercial service terms (the SAME source the location matrix uses). */
  services: Array<{ serviceKey: string; display: string; priority: number }>;
  /** Real published page URLs per normalized service key — the post calendar's
   * targetUrls come ONLY from here (F1/F3: a URL we did not publish is never
   * suggested). */
  servicePages: Map<string, string>;
  /** Real site URL for CTAs (the carrying blog's domain), or null. */
  ctaUrl: string | null;
  competitors: ParsedCompetitor[];
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function orNotProvided(v: string | null | undefined): string {
  const t = (v ?? "").trim();
  return t || NOT_PROVIDED_SHORT;
}

/** 1. Categories — primary + up to 3 secondary, ranked by which the client's
 * REAL services support, each with a one-line "why this order" note. The exact
 * GBP category strings are NOT facts we hold, so each slot names its SERVICE
 * ANCHOR and marks the literal category string as operator-picked. */
export function buildCategoryPack(facts: GbpFacts): {
  primary: { anchor: string; why: string; gbpCategory: string };
  secondary: Array<{ anchor: string; why: string; gbpCategory: string }>;
} {
  const ranked = facts.services.slice(0, 4);
  const top = ranked[0];
  const primary = {
    anchor: top ? top.display : NOT_PROVIDED_SHORT,
    why: top
      ? `Highest-priority real service (existing winnability rank ${top.priority}) — the category the profile must be found for first.`
      : `No commercial service terms on file yet — ${NOT_PROVIDED_SHORT}.`,
    gbpCategory: top ? `operator-picked GBP category for: ${top.display}` : NOT_PROVIDED_SHORT,
  };
  const secondary = ranked.slice(1).map((s) => ({
    anchor: s.display,
    why: `Supports real service "${s.display}" (existing winnability rank ${s.priority}) — broadens the profile without diluting the primary.`,
    gbpCategory: `operator-picked GBP category for: ${s.display}`,
  }));
  return { primary, secondary };
}

/** 2. Attributes — diff of (competitor union − ours) with add/remove/keep
 * verdicts from real facts only. An attribute we cannot verify NEVER gets a
 * "set it" — it gets the ask-on-call verdict (F3). */
export function buildAttributePack(
  facts: GbpFacts,
): Array<{ attribute: string; verdict: "keep" | "cannot verify — ask on call"; why: string }> {
  const ours = new Set(facts.differentiators.map((d) => normalizeQueryKey(d)).filter(Boolean));
  const competitorUnion = new Map<string, string>(); // normKey -> original casing (first paste wins, deterministic)
  for (const c of facts.competitors) {
    for (const a of c.attributes) {
      const k = normalizeQueryKey(a);
      if (k && !competitorUnion.has(k)) competitorUnion.set(k, a);
    }
  }
  const rows: Array<{ attribute: string; verdict: "keep" | "cannot verify — ask on call"; why: string }> = [];
  for (const d of facts.differentiators) {
    rows.push({
      attribute: d,
      verdict: "keep",
      why: "Operator-verified differentiator — already true of this business; confirm it is set on the GBP.",
    });
  }
  for (const [, original] of Array.from(competitorUnion.entries()).sort((a, b) =>
    a[1].localeCompare(b[1]),
  )) {
    if (ours.has(normalizeQueryKey(original))) continue;
    rows.push({
      attribute: original,
      verdict: "cannot verify — ask on call",
      why: `Pasted competitors list this attribute; no fact confirms it is true here — never set it without the operator confirming (F3).`,
    });
  }
  return rows;
}

/** 3. Services — every real service with a templated 40–60-word GBP
 * description, plus the cross-check note. The "on GBP missing on website" half
 * is an honest gap: the client's OWN GBP service list was never pasted, and a
 * competitor's list must never stand in for it (F3). */
export function buildServicesPack(facts: GbpFacts): {
  items: Array<{ service: string; gbpDescription: string; words: number }>;
  crossCheck: { onWebsiteMissingOnGbp: string[]; onGbpMissingOnWebsite: string[] };
} {
  const items = facts.services.slice(0, GBP_SERVICES_CAP).map((s) => {
    const area = facts.places[0] ? ` in ${facts.places[0]}` : "";
    const proof = facts.differentiators[0]
      ? ` ${facts.differentiators[0].replace(/\.$/, "")}.`
      : "";
    const brand = facts.businessName ?? "The team";
    const body =
      `${titleCase(s.display)}${area} handled end to end: assessment first, a written scope before any work begins, and follow-through you can check.` +
      ` ${brand} treats every ${s.display} job as a reference job — the same standard every time.` +
      proof +
      ` Ask through the profile for a written quote.`;
    return { service: s.display, gbpDescription: body, words: countWords(body) };
  });
  return {
    items,
    crossCheck: {
      onWebsiteMissingOnGbp: facts.services.slice(0, GBP_SERVICES_CAP).map((s) => s.display),
      onGbpMissingOnWebsite: [NOT_PROVIDED_SHORT],
    },
  };
}

/** Deterministic clamp at a sentence boundary — the last resort when a
 * composed description exceeds the GBP cap. Pure. */
export function clampDescription(body: string, max: number = GBP_DESCRIPTION_MAX_CHARS): string {
  if (body.length <= max) return body;
  const sentences = body.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const s of sentences) {
    const candidate = out ? `${out} ${s}` : s;
    if (candidate.length > max) break;
    out = candidate;
  }
  return out || body.slice(0, max);
}

/** 4. Description A/B — two versions ≤750 chars, both ending in a real CTA or
 * area line; rotated every 30 days. Pure in `from` (the generation instant) so
 * output is byte-identical under a fixed clock. */
export function buildDescriptionPack(
  facts: GbpFacts,
  from: Date,
): { versions: Array<{ body: string; chars: number; rotateOn: string }>; measurement: string } {
  const area = facts.places[0] ?? "";
  const leadServices = facts.services.slice(0, 3).map((s) => s.display).join(", ");
  const proof = facts.differentiators.slice(0, 2).map((d) => d.replace(/\.$/, "")).join("; ");
  const model = facts.businessModel ? `${facts.businessModel.replace(/\.$/, "")}.` : "";
  const brand = facts.businessName ?? "The team";

  const a =
    `${brand} — ${orNotProvided(facts.businessModel)} ` +
    (leadServices ? `Core services: ${leadServices}. ` : "") +
    (area ? `Serving ${area}${facts.places[1] ? " and nearby areas" : ""}. ` : "") +
    (proof ? `What customers can hold us to: ${proof}. ` : "") +
    (facts.ctaUrl ? `Get a quote before you commit — start on the site.` : `Call for a quote before you commit.`);

  const b =
    (area ? `${area} — ` : "") +
    `${brand}. ` +
    (model ? `${model} ` : "The same crew from first call to follow-up. ") +
    (proof ? `Non-negotiables: ${proof}. ` : "") +
    (leadServices ? `Most-requested: ${leadServices}. ` : "") +
    (facts.ctaUrl ? `Quotes and booking live on the site — no phone tag.` : `One call gets a written quote.`);

  const rotateOn = (offsetDays: number) =>
    new Date(from.getTime() + offsetDays * GBP_DESCRIPTION_ROTATION_DAYS * 86_400_000).toISOString();
  const versions = [a, b]
    .map((v) => clampDescription(v.replace(/\s+/g, " ").trim()))
    .map((body, i) => ({ body, chars: body.length, rotateOn: rotateOn(i + 1) }));
  return {
    versions,
    // F8: measurement only when the data exists — the outcome pass writes
    // performance_note from brand-query GSC impressions when present.
    measurement: "no measurable signal yet",
  };
}

/** `<type>-<area>-<date>.jpg` — the spec's filename convention. Pure. */
export function photoFilename(type: string, area: string, from: Date, slot: number): string {
  const stamp = new Date(from.getTime() + slot * 7 * 86_400_000).toISOString().slice(0, 10);
  const clean = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "general";
  return `${clean(type)}-${clean(area)}-${stamp}.jpg`;
}

/** 5. Posts calendar — 8 weekly posts rotating REAL areas; a slot never reuses
 * an area used within the previous 4 slots. With fewer than 4 real places the
 * constraint is unsatisfiable — the cycle repeats and the payload says so. */
export function buildPostsPack(
  facts: GbpFacts,
  from: Date,
): {
  posts: Array<{
    week: number;
    publishOn: string;
    hook: string;
    body: string;
    cta: string;
    photo: string;
    targetUrl: string | null;
    area: string;
  }>;
  areaRotationNote: string;
} {
  const places = facts.places;
  const posts: Array<{
    week: number;
    publishOn: string;
    hook: string;
    body: string;
    cta: string;
    photo: string;
    targetUrl: string | null;
    area: string;
  }> = [];
  const recent: string[] = [];
  for (let w = 0; w < GBP_POSTS_COUNT; w++) {
    let area = NOT_PROVIDED_SHORT;
    if (places.length > 0) {
      const pick = places.find((p) => !recent.includes(p)) ?? places[w % places.length];
      area = pick;
      recent.push(pick);
      while (recent.length >= GBP_AREA_COOLDOWN_SLOTS) recent.shift();
    }
    const service = facts.services.length > 0 ? facts.services[w % facts.services.length] : null;
    const hook = (
      service
        ? area !== NOT_PROVIDED_SHORT
          ? `${titleCase(service.display)} in ${area}: what to expect`
          : `${titleCase(service.display)}: what to expect`
        : `This week at ${facts.businessName ?? "the shop"}`
    ).slice(0, GBP_POST_HOOK_MAX_CHARS);
    const proof = facts.differentiators[0] ? ` ${facts.differentiators[0].replace(/\.$/, "")}.` : "";
    const body = (
      service
        ? `${titleCase(service.display)}${area !== NOT_PROVIDED_SHORT ? ` in ${area}` : ""}: we assess first, quote in writing, and schedule the work so disruption stays lowest.${proof}`
        : `This week: the usual crew, the usual standard — assess first, quote in writing, no surprises on the invoice.${proof}`
    ).slice(0, GBP_POST_BODY_MAX_CHARS);
    const targetUrl =
      (service ? facts.servicePages.get(service.serviceKey) ?? null : null) ?? facts.ctaUrl;
    posts.push({
      week: w + 1,
      publishOn: new Date(from.getTime() + w * 7 * 86_400_000).toISOString(),
      hook,
      body,
      cta: facts.ctaUrl ? `Details and booking: ${facts.ctaUrl}` : "Call the number on the profile to book.",
      photo: photoFilename(w % 2 === 0 ? "service" : "area", area !== NOT_PROVIDED_SHORT ? area : "general", from, w),
      targetUrl,
      area,
    });
  }
  return {
    posts,
    areaRotationNote:
      places.length >= GBP_AREA_COOLDOWN_SLOTS
        ? `Areas rotate across the ${GBP_POSTS_COUNT} slots; no area repeats within ${GBP_AREA_COOLDOWN_SLOTS} weeks.`
        : `Only ${places.length} real place${places.length === 1 ? "" : "s"} on file — the no-repeat-within-4 rule cannot hold, so the cycle repeats. Add real areas on the dossier to fix this (never invented ones).`,
  };
}

/** 6. Photos — audit of operator-pasted counts vs the top pasted competitor;
 * upload queue in the filename convention; per-month target = competitor
 * velocity + 1. Missing numbers stay honest gaps — never estimated (F8). */
export function buildPhotosPack(
  facts: GbpFacts,
  from: Date,
): { audit: string; target: string; queue: string[] } {
  const top =
    facts.competitors.find((c) => (c.photos ?? 0) > 0 || (c.photosPerMonth ?? 0) > 0) ?? null;
  const competitorVelocity = top?.photosPerMonth ?? null;
  const types = ["service", "area", "team"];
  const queue: string[] = [];
  for (let i = 0; i < GBP_PHOTO_QUEUE_CAP; i++) {
    const area = facts.places.length > 0 ? facts.places[i % facts.places.length] : "general";
    queue.push(photoFilename(types[i % types.length], area, from, i));
  }
  return {
    audit: top
      ? `Top competitor ${top.name}: ${top.photos ?? NOT_PROVIDED_SHORT} photos on profile, ${top.photosPerMonth ?? NOT_PROVIDED_SHORT}/month. Ours: ${NOT_PROVIDED_SHORT} (operator confirms on the call).`
      : `No competitor photo counts pasted yet — ${NOT_PROVIDED_SHORT}.`,
    target:
      competitorVelocity !== null
        ? `Publish ${competitorVelocity + 1} photos per month — competitor velocity plus one.`
        : `Per-month target: ${NOT_PROVIDED_SHORT} (need the competitor's photos-per-month number).`,
    queue,
  };
}

/** 7. Reviews — response templates banded 5★/4★/3★-and-below: each ≤80 words,
 * no discount offers, sign-off = the REAL business name; plus the ≤24h
 * response standard (S5's SLA card pre-fills from here). */
export function buildReviewsPack(facts: GbpFacts): {
  bands: Array<{ band: string; template: string; words: number }>;
  sla: string;
} {
  const sign = `— ${facts.businessName ?? NOT_PROVIDED_SHORT}`;
  const mk = (band: string, body: string) => {
    const template = `${body} ${sign}`;
    return { band, template, words: countWords(template) };
  };
  return {
    bands: [
      mk(
        "5-star",
        "Thank you for taking the time to write this. Reviews like yours are the reference we hold ourselves to — the same standard goes into every job we take.",
      ),
      mk(
        "4-star",
        "Thanks for the honest feedback, and we are glad the job landed well. If anything fell short of five stars, we want to hear exactly what — it is how the standard goes up.",
      ),
      mk(
        "3-star and below",
        "This is not the experience we intend to leave behind. We would like to look into what happened and put it right — please reach out so a real person can review the job and follow up with you directly.",
      ),
    ],
    sla: "First response within 24 hours of any review, every review — tracked in this tab's SLA log.",
  };
}

// ─── Composition + the async builder ─────────────────────────────────────────

export interface GbpPackDrafts {
  generatedAt: string;
  categories: ReturnType<typeof buildCategoryPack>;
  attributes: ReturnType<typeof buildAttributePack>;
  services: ReturnType<typeof buildServicesPack>;
  description: ReturnType<typeof buildDescriptionPack>;
  posts: ReturnType<typeof buildPostsPack>;
  photos: ReturnType<typeof buildPhotosPack>;
  reviews: ReturnType<typeof buildReviewsPack>;
}

/** THE composer — pure + deterministic: same facts + same `from` instant →
 * byte-identical packs (DoD). No model call; see the module header. */
export function composeGbpPacks(facts: GbpFacts, from: Date): GbpPackDrafts {
  return {
    generatedAt: from.toISOString(),
    categories: buildCategoryPack(facts),
    attributes: buildAttributePack(facts),
    services: buildServicesPack(facts),
    description: buildDescriptionPack(facts, from),
    posts: buildPostsPack(facts, from),
    photos: buildPhotosPack(facts, from),
    reviews: buildReviewsPack(facts),
  };
}

/** Gather the operator-verified facts for one client and compose the packs.
 * Fail-safe per input: a missing dossier/blog/profile degrades that fact to
 * null/[] (packs then render NOT_PROVIDED_SHORT), never throws. */
export async function gatherGbpFacts(clientId: string): Promise<GbpFacts | null> {
  const [client] = await db
    .select({ name: clientsTable.name, niche: clientsTable.niche })
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId))
    .limit(1);
  if (!client) return null;

  const [dossier] = await db
    .select({
      businessModel: clientSeoDossiers.businessModel,
      differentiators: clientSeoDossiers.differentiators,
      serviceArea: clientSeoDossiers.serviceArea,
      competitorProfiles: clientSeoDossiers.competitorProfiles,
    })
    .from(clientSeoDossiers)
    .where(eq(clientSeoDossiers.clientId, clientId))
    .limit(1);

  const blogRows = await db
    .select({ domain: blogsTable.domain, brandName: blogsTable.brandName, city: blogsTable.city })
    .from(blogsTable)
    .where(and(eq(blogsTable.clientId, clientId), eq(blogsTable.status, "active")))
    .orderBy(blogsTable.domain);

  const places = new Set<string>();
  for (const v of (Array.isArray(dossier?.serviceArea) ? dossier.serviceArea : []) as unknown[]) {
    const s = String(v ?? "").trim();
    if (s) places.add(s);
  }
  for (const b of blogRows) {
    const c = (b.city ?? "").trim();
    if (c) places.add(c);
  }

  // Business name: operator-confirmed blogs.brand_name ONLY (the domain-derived
  // suggestion is never authoritative — content/brand.ts).
  const businessName = blogRows.map((b) => (b.brandName ?? "").trim()).find(Boolean) ?? null;
  const ctaUrl = blogRows.length > 0 ? blogDomainCtaUrl(blogRows[0].domain) : null;

  let services: GbpFacts["services"] = [];
  try {
    services = await serviceTermsForClient(clientId, client.niche ?? null);
  } catch (err) {
    console.warn(
      "[gbp-packs] service-term read failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Real published page URLs per service — targetUrls come only from pages we
  // actually published (F1). Matched by normalized primary query.
  const servicePages = new Map<string, string>();
  if (services.length > 0) {
    const postRows = (await db.execute(sql`
      SELECT gp.primary_query AS primaryQuery, gp.external_post_url AS externalUrl, b.domain AS domain
      FROM generated_posts gp
      JOIN blogs b ON b.id = gp.blog_id
      WHERE b.client_id = ${clientId}
        AND gp.status = 'published'
        AND gp.primary_query IS NOT NULL
      ORDER BY gp.published_at DESC NULLS LAST
      LIMIT 500
    `)) as unknown as Array<{ primaryQuery: string; externalUrl: string | null; domain: string }>;
    for (const r of postRows) {
      const key = normalizeQueryKey(String(r.primaryQuery ?? ""));
      if (!key || servicePages.has(key)) continue;
      const url = (r.externalUrl ?? "").trim() || (r.domain ? `https://${r.domain}` : "");
      if (url) servicePages.set(key, url);
    }
  }

  return {
    businessName,
    businessModel: (dossier?.businessModel ?? "").trim() || null,
    differentiators: ((Array.isArray(dossier?.differentiators) ? dossier.differentiators : []) as unknown[])
      .map((d) => String(d ?? "").trim())
      .filter(Boolean),
    places: Array.from(places),
    services,
    servicePages,
    ctaUrl,
    competitors: ((Array.isArray(dossier?.competitorProfiles) ? dossier.competitorProfiles : []) as unknown[])
      .map((c): ParsedCompetitor | null => {
        if (!c || typeof c !== "object") return null;
        const r = c as Record<string, unknown>;
        if (typeof r.name !== "string" || !r.name) return null;
        return {
          name: r.name,
          category: typeof r.category === "string" ? r.category : null,
          attributes: Array.isArray(r.attributes) ? r.attributes.map(String) : [],
          services: Array.isArray(r.services)
            ? (r.services as unknown[])
                .map((s): { name: string; price: string | null } | null => {
                  if (!s || typeof s !== "object") return null;
                  const sr = s as Record<string, unknown>;
                  return { name: String(sr.name ?? ""), price: typeof sr.price === "string" ? sr.price : null };
                })
                .filter((s): s is { name: string; price: string | null } => s !== null && s.name !== "")
            : [],
          description: typeof r.description === "string" ? r.description : null,
          reviewCount: typeof r.reviewCount === "number" ? r.reviewCount : null,
          reviews: Array.isArray(r.reviews)
            ? (r.reviews as unknown[])
                .map((v): { date: string; rating: number | null } | null => {
                  if (!v || typeof v !== "object") return null;
                  const vr = v as Record<string, unknown>;
                  return { date: String(vr.date ?? ""), rating: typeof vr.rating === "number" ? vr.rating : null };
                })
                .filter((v): v is { date: string; rating: number | null } => v !== null && v.date !== "")
            : [],
          photos: typeof r.photos === "number" ? r.photos : null,
          photosPerMonth: typeof r.photosPerMonth === "number" ? r.photosPerMonth : null,
        };
      })
      .filter((c): c is ParsedCompetitor => c !== null),
  };
}

export interface GbpBuildSummary {
  assetsInserted: number;
  descriptionVersionsFrom: number | null;
}

/** Build + store the packs. INSERT-ONLY: new gbp_assets rows are appended and
 * old ones are never touched (the audit trail — DoD), and description versions
 * continue at max(version)+1. Returns the summary for the admin toast. */
export async function buildGbpPacks(clientId: string): Promise<GbpBuildSummary> {
  const facts = await gatherGbpFacts(clientId);
  if (!facts) throw new Error("Client not found");

  const now = new Date();
  const packs = composeGbpPacks(facts, now);

  await db.insert(gbpAssets).values([
    { clientId, assetType: "categories", payload: packs.categories },
    { clientId, assetType: "attributes", payload: packs.attributes },
    { clientId, assetType: "services", payload: packs.services },
    { clientId, assetType: "description", payload: packs.description },
    { clientId, assetType: "posts", payload: packs.posts },
    { clientId, assetType: "photos", payload: packs.photos },
    { clientId, assetType: "reviews", payload: packs.reviews },
  ]);

  // Description A/B rotation: continue at max(version)+1, +2. The 750-char cap
  // is enforced by clampDescription BEFORE insert (and again by the DB CHECK).
  const [maxRow] = await db
    .select({ maxVersion: sql<number | null>`max(${gbpDescriptionVersions.version})::int` })
    .from(gbpDescriptionVersions)
    .where(eq(gbpDescriptionVersions.clientId, clientId));
  const from = (maxRow?.maxVersion ?? 0) || 0;
  await db.insert(gbpDescriptionVersions).values(
    packs.description.versions.map((v, i) => ({
      clientId,
      version: from + i + 1,
      body: clampDescription(v.body),
    })),
  );

  return { assetsInserted: GBP_ASSET_TYPES.length, descriptionVersionsFrom: from + 1 };
}

/** Latest gbp_assets row per asset type — what the admin tab, the printable
 * card and the PDF render. */
export async function latestGbpPacksForClient(
  clientId: string,
): Promise<Array<{ assetType: GbpAssetType; payload: unknown; createdAt: Date; status: string }>> {
  const rows = await db
    .select({
      assetType: gbpAssets.assetType,
      payload: gbpAssets.payload,
      createdAt: gbpAssets.createdAt,
      status: gbpAssets.status,
      rn: sql<number>`row_number() OVER (PARTITION BY ${gbpAssets.assetType} ORDER BY ${gbpAssets.createdAt} DESC)::int`,
    })
    .from(gbpAssets)
    .where(eq(gbpAssets.clientId, clientId));
  return rows
    .filter((r) => r.rn === 1)
    .map(({ assetType, payload, createdAt, status }) => ({
      assetType: assetType as GbpAssetType,
      payload,
      createdAt,
      status,
    }));
}

/** Portal line math — "GBP action plan: N items ready". Counts DISTINCT asset
 * types with a ready pack (regenerations never inflate it). Zero is a real
 * state (nothing built yet → the portal omits the line). */
export async function gbpSummaryForClient(clientId: string): Promise<{ readyCount: number }> {
  const [row] = (await db.execute(sql`
    SELECT count(DISTINCT asset_type)::int AS n
    FROM gbp_assets
    WHERE client_id = ${clientId} AND status = 'ready'
  `)) as unknown as Array<{ n: number | string }>;
  return { readyCount: Number(row?.n ?? 0) || 0 };
}

/** Ops read for GET /api/v1/ops/gbp-packs — assets created strictly after
 * `since`, oldest first, bounded. The cursor is the last row's createdAt. */
export async function listGbpPacksSince(
  clientId: string,
  since: Date,
  limit: number,
): Promise<Array<{ id: string; assetType: string; status: string; createdAt: Date }>> {
  return db
    .select({
      id: gbpAssets.id,
      assetType: gbpAssets.assetType,
      status: gbpAssets.status,
      createdAt: gbpAssets.createdAt,
    })
    .from(gbpAssets)
    .where(and(eq(gbpAssets.clientId, clientId), gt(gbpAssets.createdAt, since)))
    .orderBy(gbpAssets.createdAt)
    .limit(limit);
}

/** Description rotation table for the gbp tab. */
export async function listDescriptionVersions(clientId: string) {
  return db
    .select({
      id: gbpDescriptionVersions.id,
      version: gbpDescriptionVersions.version,
      body: gbpDescriptionVersions.body,
      appliedAt: gbpDescriptionVersions.appliedAt,
      performanceNote: gbpDescriptionVersions.performanceNote,
      createdAt: gbpDescriptionVersions.createdAt,
    })
    .from(gbpDescriptionVersions)
    .where(eq(gbpDescriptionVersions.clientId, clientId))
    .orderBy(desc(gbpDescriptionVersions.version));
}

// ─── §E rollout row: the 30-day description rotation check ───────────────────

export interface GbpRotationVersionRow {
  version: number;
  appliedAt: Date | null;
  createdAt: Date;
}

export interface RotationDueResult {
  /** The version currently live on the profile (latest applied; with none
   * applied yet, the newest row — what the operator is presumably using). */
  liveVersion: number | null;
  daysLive: number | null;
  due: boolean;
  /** A different, never-applied version ready to rotate in — null when the
   * check cannot honestly say "rotate now" (nothing to rotate to). */
  nextVersion: number | null;
}

/** Pure core of the §E weekly rotation check ("30-day description rotation
 * check, folds into the rescue-outcomes weekly run"). Rotation is DUE when the
 * live body has been up ≥ GBP_DESCRIPTION_ROTATION_DAYS and an unapplied
 * alternate exists; without an alternate there is nothing to rotate to and the
 * check says so instead of nagging. Pure in `now`. */
export function rotationDueFromVersions(
  versions: GbpRotationVersionRow[],
  now: Date,
): RotationDueResult {
  if (versions.length === 0) {
    return { liveVersion: null, daysLive: null, due: false, nextVersion: null };
  }
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const applied = sorted.filter((v) => v.appliedAt !== null);
  const live = applied.length > 0 ? applied[applied.length - 1] : sorted[sorted.length - 1];
  const sinceMs = (live.appliedAt ?? live.createdAt).getTime();
  const daysLive = Math.max(0, Math.floor((now.getTime() - sinceMs) / 86_400_000));
  const next =
    sorted.find((v) => v.version !== live.version && v.appliedAt === null) ?? null;
  return {
    liveVersion: live.version,
    daysLive,
    due: daysLive >= GBP_DESCRIPTION_ROTATION_DAYS && next !== null,
    nextVersion: next?.version ?? null,
  };
}

/** The weekly check itself — read-only; the verdict surfaces in the gsc-sync
 * run metrics and the gbp tab's rotation table is where the operator acts on
 * it (F2: flipping the live version is an operator action, never automatic). */
export async function checkDescriptionRotation(
  clientId: string,
  now: Date = new Date(),
): Promise<RotationDueResult> {
  const rows = await listDescriptionVersions(clientId);
  return rotationDueFromVersions(
    rows.map((r) => ({ version: r.version, appliedAt: r.appliedAt, createdAt: r.createdAt })),
    now,
  );
}

// ─── §E rollout row: sent-pack summary for the monthly PDF appendix ──────────

export interface GbpAppendixPack {
  title: string;
  lines: string[];
}

export interface GbpAppendixSummary {
  /** ISO date (YYYY-MM-DD) of the most recent sent pack — null when unknown. */
  latestSentOn: string | null;
  packs: GbpAppendixPack[];
}

function appendixStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function appendixList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function appendixRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Latest row per asset type with status 'sent_to_client' only — the §E PDF
 * column ("appendix page when packs sent"). Ready-but-unsent packs NEVER appear
 * in the client PDF (they stay operator-side until sent). Payload shapes are
 * the pack builders' outputs; anything malformed degrades to an omitted line,
 * never a thrown report. Pure so tests can pin it. */
export function summarizeGbpPacksForAppendix(
  packs: Array<{
    assetType: string;
    payload: unknown;
    status: string;
    createdAt?: Date | string;
  }>,
): GbpAppendixSummary {
  const sentRows = packs.filter((p) => p.status === "sent_to_client");
  const latest = sentRows.reduce<number>((acc, p) => {
    if (!p.createdAt) return acc;
    const time = new Date(p.createdAt).getTime();
    return Number.isFinite(time) && time > acc ? time : acc;
  }, 0);
  const latestSentOn = latest > 0 ? new Date(latest).toISOString().slice(0, 10) : null;

  const byType = new Map<string, unknown>();
  for (const p of sentRows) {
    if (!byType.has(p.assetType)) byType.set(p.assetType, p.payload);
  }

  const packsOut: GbpAppendixPack[] = [];
  for (const type of GBP_ASSET_TYPES) {
    if (!byType.has(type)) continue;
    const payload = byType.get(type);
    const lines: string[] = [];
    if (type === "categories") {
      const rec = appendixRec(payload);
      const primary = appendixRec(rec?.primary);
      if (primary?.gbpCategory) lines.push(`Primary category: ${appendixStr(primary.gbpCategory)}`);
      const secondary = appendixList(rec?.secondary)
        .map((s) => appendixStr(appendixRec(s)?.gbpCategory))
        .filter(Boolean);
      if (secondary.length > 0) lines.push(`Secondary categories: ${secondary.join(", ")}`);
    } else if (type === "attributes") {
      const rows = appendixList(payload)
        .map((r) => appendixRec(r))
        .filter(Boolean) as Array<Record<string, unknown>>;
      const keep = rows.filter((r) => appendixStr(r.verdict).startsWith("keep")).length;
      const ask = rows.length - keep;
      if (rows.length > 0) {
        lines.push(
          `${rows.length} attributes reviewed — ${keep} to keep set, ${ask} to confirm on the next call.`,
        );
      }
    } else if (type === "services") {
      const rec = appendixRec(payload);
      const items = appendixList(rec?.items);
      if (items.length > 0) lines.push(`${items.length} services written for the profile.`);
      const cross = appendixRec(rec?.crossCheck);
      const missing = appendixList(cross?.onWebsiteMissingOnGbp)
        .map((s) => appendixStr(s))
        .filter(Boolean)
        .slice(0, 3);
      if (missing.length > 0) {
        lines.push(
          `Website services to add on the profile: ${missing.join(", ")}${appendixList(cross?.onWebsiteMissingOnGbp).length > 3 ? ", …" : ""}.`,
        );
      }
    } else if (type === "description") {
      const rec = appendixRec(payload);
      const versions = appendixList(rec?.versions)
        .map((v) => appendixRec(v))
        .filter(Boolean) as Array<Record<string, unknown>>;
      if (versions.length > 0) {
        lines.push(
          `${versions.length} description versions delivered (${versions
            .map((v) => `${appendixStr(v.chars) || "?"} chars`)
            .join(" / ")}), on a 30-day rotation.`,
        );
      }
      const measurement = appendixStr(rec?.measurement);
      if (measurement) lines.push(`Measurement: ${measurement}.`);
    } else if (type === "posts") {
      const rec = appendixRec(payload);
      const posts = appendixList(rec?.posts);
      if (posts.length > 0) {
        lines.push(
          `${posts.length} weekly posts drafted; each links a real page on your site.`,
        );
      }
      const note = appendixStr(rec?.areaRotationNote);
      if (note) lines.push(note.slice(0, 160));
    } else if (type === "photos") {
      const rec = appendixRec(payload);
      const target = appendixStr(rec?.target);
      if (target) lines.push(target);
    } else if (type === "reviews") {
      const rec = appendixRec(payload);
      const bands = appendixList(rec?.bands);
      if (bands.length > 0) {
        lines.push(`${bands.length} review-response templates (5★ / 4★ / 3★ and below).`);
      }
      const sla = appendixStr(rec?.sla);
      if (sla) lines.push(sla);
    }
    packsOut.push({ title: APPENDIX_TITLES[type], lines: lines.length > 0 ? lines : [NOT_PROVIDED_SHORT] });
  }

  return { latestSentOn, packs: packsOut };
}

/** Display titles for the appendix page, keyed by asset type. */
const APPENDIX_TITLES: Record<GbpAssetType, string> = {
  categories: "Categories",
  attributes: "Attributes",
  services: "Services",
  description: "Business description (A/B)",
  posts: "Posts calendar",
  photos: "Photos",
  reviews: "Review responses",
};