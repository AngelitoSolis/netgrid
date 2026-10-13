/**
 * PDF renderer for monthly client reports.
 *
 * Uses @react-pdf/renderer (pure-Node, no Chromium dependency) so the
 * renderer runs in the same serverless Node environment as the rest of
 * the app — no special build step, no Chromium binary on Render.
 *
 * Input shape mirrors the `reports` table row plus the client's name.
 * Output is a Buffer suitable for direct attachment via Resend.
 *
 * Layout is intentionally minimal: title, period, top-line metrics,
 * highlights list, concerns list, and an optional HTML-stripped summary
 * paragraph. No charts (those would require canvas + chrome).
 */

import * as React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  pdf,
  Font,
} from "@react-pdf/renderer";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReportPdfData {
  clientName: string;
  periodStart: string; // ISO date "YYYY-MM-DD"
  periodEnd: string;
  title: string | null;
  summaryHtml: string | null;
  overallSeoTrend: "improving" | "stable" | "declining" | null;
  avgSeoScore: number | null;
  totalPostsPublished: number | null;
  totalIssuesFixed: number | null;
  blogsOnSchedule: number | null;
  blogsOffSchedule: number | null;
  highlights: unknown; // jsonb — coerced below
  concerns: unknown;
  /** S1/S2 proof layer — "Queries that moved": one row per rescue/pin whose
   * outcome was MEASURED as resolved-or-stable in the report period (F8: a delta
   * is only present when both measurements exist). Null/empty = section omitted. */
  queriesThatMoved?: QueryMoveRow[] | null;
  /** S3 — location coverage line: direct ledger counts (the published-this-
   * period and planned-total measurements ride together — F8). Null = no
   * actionable matrix yet → the line omits itself. */
  locationCoverage?: {
    publishedInPeriod: number;
    generatedTotal: number;
    actionableTotal: number;
  } | null;
  /** S7 — "This month's sprint": the plan artifact STORED on this report row
   * (reports.raw_data.sprint), never a live recompute at render time. The
   * structural shape below is what MonthlySprintPlan serializes to. */
  sprintPlan?: SprintPlanPdfData | null;
  /** S7 — last month's completed-vs-planned score, evaluated against current
   * machine state when this report was generated. Null = section prints "—". */
  lastMonthSprintScore?: { period: string; done: number; total: number } | null;
  /** S6 — "What we know about your business" (§E: first-page section). The
   * operator-verified dossier, condensed for the client. Null = section
   * omits (no dossier yet is an expected state, never a failure). */
  dossierSummary?: DossierPdfSummary | null;
  /** S5 — the renewal one-liner, only when a real parity state exists.
   * Null = omitted (F8: silence is never backfilled with a guess). */
  reviewParityLine?: string | null;
  /** S2/S8 — open ledger counts "consolidated under sprint notes" (§E).
   * Null = nothing is awaiting a decision. */
  hygieneNote?: string | null;
  /** S4 — the appendix page, present ONLY when packs were sent to the client
   * (ready-but-unsent packs stay operator-side). */
  gbpAppendix?: GbpAppendixPdfData | null;
}

/** S6 — what the "What we know about your business" PDF section renders. */
export interface DossierPdfSummary {
  /** YYYY-MM-DD of the operator's last verification, when it happened. */
  verifiedOn: string | null;
  /** The >90-day staleness warning line, when the reader pre-computed one. */
  staleWarning: string | null;
  businessModel: string | null;
  serviceArea: string[];
  differentiators: string[];
  audience: string | null;
  recentWins: string[];
  gaps: string | null;
}

/** S4 — the appendix page's data: only packs actually SENT to the client. */
export interface GbpAppendixPdfData {
  /** YYYY-MM-DD the most recent pack was sent, when known. */
  sentOn: string | null;
  packs: Array<{ title: string; lines: string[] }>;
}

/** One proven-movement row for the "Queries that moved" PDF section. */
export interface QueryMoveRow {
  query: string;
  pageUrl: string | null;
  beforePosition: number | null;
  afterPosition: number | null;
  /** Positive = improved (moved UP). */
  deltaPositions: number | null;
  appliedAt: string | null; // ISO
}

/** S7 sprint plan as the PDF renders it (structural — matches the persisted
 * MonthlySprintPlan artifact without coupling this module to the planner). */
export interface SprintPlanPdfData {
  period: string; // YYYY-MM the plan targets
  generatedAt: string; // ISO
  fallback: boolean;
  fallbackReason?: string | null;
  contentDepthNote: string;
  weeks: Array<{ week: number; items: Array<{ id: string; family: string; title: string; owner: string }> }>;
}

// ─── Styling ────────────────────────────────────────────────────────────────

// @react-pdf ships with Helvetica/Times-Roman/Courier built-in. We use the
// defaults to avoid bundling extra font files into the Lambda.
Font.register({
  family: "Helvetica",
  fonts: [{ src: "Helvetica" }, { src: "Helvetica-Bold", fontWeight: 700 }],
});

const styles = StyleSheet.create({
  page: {
    padding: 48,
    fontFamily: "Helvetica",
    fontSize: 11,
    color: "#111",
    lineHeight: 1.5,
  },
  header: {
    borderBottomWidth: 1,
    borderBottomColor: "#111",
    paddingBottom: 12,
    marginBottom: 20,
  },
  brand: {
    fontSize: 9,
    color: "#666",
    letterSpacing: 2,
    marginBottom: 4,
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
  },
  period: {
    fontSize: 10,
    color: "#555",
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 700,
    marginTop: 18,
    marginBottom: 8,
    color: "#111",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 6,
  },
  metric: {
    width: "50%",
    paddingVertical: 6,
    paddingRight: 8,
  },
  metricLabel: {
    fontSize: 9,
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  metricValue: {
    fontSize: 16,
    fontWeight: 700,
    marginTop: 2,
  },
  paragraph: {
    marginBottom: 8,
  },
  bulletRow: {
    flexDirection: "row",
    marginBottom: 4,
  },
  bullet: {
    width: 12,
  },
  bulletText: {
    flex: 1,
  },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 48,
    right: 48,
    borderTopWidth: 1,
    borderTopColor: "#ddd",
    paddingTop: 8,
    fontSize: 8,
    color: "#888",
    textAlign: "center",
  },
  trendImproving: { color: "#0a7d32" },
  trendStable: { color: "#5a5a5a" },
  trendDeclining: { color: "#a3261a" },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatPeriod(start: string, end: string): string {
  try {
    const s = new Date(start);
    const e = new Date(end);
    const opts: Intl.DateTimeFormatOptions = {
      month: "long",
      day: "numeric",
      year: "numeric",
    };
    return `${s.toLocaleDateString("en-US", opts)} — ${e.toLocaleDateString("en-US", opts)}`;
  } catch {
    return `${start} — ${end}`;
  }
}

function stripHtml(html: string | null): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v : v == null ? "" : String(v)))
    .filter((s) => s.trim().length > 0);
}

/** One decimal place for rendered positions in "Queries that moved". */
function fmtPos(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Signed position delta — positive reads as an improvement, per F8. */
function fmtDelta(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return "no measurable change";
  const r = Math.round(Math.abs(delta) * 10) / 10;
  if (r === 0) return "steady";
  return delta > 0 ? `up ${r} positions` : `down ${r} positions`;
}

function trendStyle(trend: ReportPdfData["overallSeoTrend"]) {
  switch (trend) {
    case "improving":
      return styles.trendImproving;
    case "declining":
      return styles.trendDeclining;
    default:
      return styles.trendStable;
  }
}

function trendLabel(trend: ReportPdfData["overallSeoTrend"]): string {
  switch (trend) {
    case "improving":
      return "Improving";
    case "declining":
      return "Declining";
    case "stable":
      return "Stable";
    default:
      return "—";
  }
}

// ─── Document component ────────────────────────────────────────────────────

interface MonthlyReportDocumentProps {
  data: ReportPdfData;
}

const MonthlyReportDocument: React.FC<MonthlyReportDocumentProps> = ({ data }) => {
  const highlights = toStringArray(data.highlights);
  const concerns = toStringArray(data.concerns);
  const summaryText = stripHtml(data.summaryHtml);
  const generatedAt = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Document
      title={data.title ?? `${data.clientName} Report`}
      author="NETGRID"
      subject={`Performance report for ${data.clientName}`}
    >
      <Page size="LETTER" style={styles.page} wrap>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.brand}>NETGRID</Text>
          <Text style={styles.title}>
            {data.title ?? `${data.clientName} — Performance Report`}
          </Text>
          <Text style={styles.period}>
            {formatPeriod(data.periodStart, data.periodEnd)}
          </Text>
        </View>

        {/* Metrics */}
        <Text style={styles.sectionTitle}>At a Glance</Text>
        <View style={styles.metricGrid}>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Posts Published</Text>
            <Text style={styles.metricValue}>
              {data.totalPostsPublished ?? "—"}
            </Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Average SEO Score</Text>
            <Text style={styles.metricValue}>{data.avgSeoScore ?? "—"}</Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>SEO Trend</Text>
            <Text style={[styles.metricValue, trendStyle(data.overallSeoTrend)]}>
              {trendLabel(data.overallSeoTrend)}
            </Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Issues Fixed</Text>
            <Text style={styles.metricValue}>
              {data.totalIssuesFixed ?? "—"}
            </Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Blogs On Schedule</Text>
            <Text style={styles.metricValue}>
              {data.blogsOnSchedule ?? "—"}
            </Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Blogs Off Schedule</Text>
            <Text style={styles.metricValue}>
              {data.blogsOffSchedule ?? "—"}
            </Text>
          </View>
        </View>

        {/* S6 — What we know about your business (§E: first page). Operator-
            verified facts only; anything missing prints as "not provided yet"
            rather than being invented (F3/F8). */}
        {data.dossierSummary ? (
          <>
            <Text style={styles.sectionTitle}>What We Know About Your Business</Text>
            <Text style={{ fontSize: 9, color: "#444", marginBottom: 6 }}>
              {data.dossierSummary.verifiedOn
                ? `Facts below were last verified with you on ${data.dossierSummary.verifiedOn}.`
                : "Verification with you is upcoming — these are the facts on file so far."}
            </Text>
            {data.dossierSummary.staleWarning ? (
              <Text style={{ fontSize: 8, color: "#a3261a", marginBottom: 6 }}>
                {data.dossierSummary.staleWarning}
              </Text>
            ) : null}
            <View style={styles.bulletRow}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.bulletText}>
                What you sell: {data.dossierSummary.businessModel ?? "not provided yet"}
              </Text>
            </View>
            <View style={styles.bulletRow}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.bulletText}>
                Where you serve:{" "}
                {data.dossierSummary.serviceArea.length > 0
                  ? data.dossierSummary.serviceArea.join(", ")
                  : "not provided yet"}
              </Text>
            </View>
            {data.dossierSummary.differentiators.map((d, i) => (
              <View key={`dz-${i}`} style={styles.bulletRow}>
                <Text style={styles.bullet}>•</Text>
                <Text style={styles.bulletText}>What sets you apart: {d}</Text>
              </View>
            ))}
            <View style={styles.bulletRow}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.bulletText}>
                Who buys from you: {data.dossierSummary.audience ?? "not provided yet"}
              </Text>
            </View>
            {data.dossierSummary.recentWins.map((w, i) => (
              <View key={`wn-${i}`} style={styles.bulletRow}>
                <Text style={styles.bullet}>•</Text>
                <Text style={styles.bulletText}>Recent win: {w}</Text>
              </View>
            ))}
            {data.dossierSummary.gaps ? (
              <Text style={{ fontSize: 8, color: "#777", marginTop: 4 }}>
                Open questions we want to confirm with you: {data.dossierSummary.gaps}
              </Text>
            ) : null}
          </>
        ) : null}

        {/* Summary */}
        {summaryText ? (
          <>
            <Text style={styles.sectionTitle}>Summary</Text>
            {summaryText.split(/\n{2,}/).map((para, i) => (
              <Text key={`p-${i}`} style={styles.paragraph}>
                {para}
              </Text>
            ))}
          </>
        ) : null}

        {/* Highlights */}
        {highlights.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Highlights</Text>
            {highlights.map((item, i) => (
              <View key={`h-${i}`} style={styles.bulletRow}>
                <Text style={styles.bullet}>•</Text>
                <Text style={styles.bulletText}>{item}</Text>
              </View>
            ))}
          </>
        ) : null}

        {/* Concerns */}
        {concerns.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Areas of Concern</Text>
            {concerns.map((item, i) => (
              <View key={`c-${i}`} style={styles.bulletRow}>
                <Text style={styles.bullet}>•</Text>
                <Text style={styles.bulletText}>{item}</Text>
              </View>
            ))}
          </>
        ) : null}

        {/* Queries that moved — S1/S2 proof layer (F8: only rows where BOTH
            before/after measurements exist; a delta here is proven movement). */}
        {data.queriesThatMoved && data.queriesThatMoved.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Queries That Moved</Text>
            {data.queriesThatMoved.map((row, i) => (
              <View key={`q-${i}`} style={{ marginBottom: 8 }}>
                <Text style={{ fontSize: 10, fontWeight: 700 }}>{row.query}</Text>
                <Text style={{ fontSize: 9, color: "#444", marginTop: 2 }}>
                  {(row.pageUrl ?? "—").slice(0, 90)} — position {fmtPos(row.beforePosition)} to{" "}
                  {fmtPos(row.afterPosition)} ({fmtDelta(row.deltaPositions)}) · applied{" "}
                  {(row.appliedAt ?? "").slice(0, 10) || "recent"}
                </Text>
              </View>
            ))}
          </>
        ) : null}

        {/* S3 — service-area coverage, straight from the location ledger. */}
        {data.locationCoverage && data.locationCoverage.actionableTotal > 0 ? (
          <Text style={{ fontSize: 9, color: "#444", marginTop: 8 }}>
            Service-area pages: {data.locationCoverage.publishedInPeriod} published this period
            {" · "}
            {Math.round(
              (100 * data.locationCoverage.generatedTotal) /
                data.locationCoverage.actionableTotal,
            )}
            % of {data.locationCoverage.actionableTotal} planned locations covered.
          </Text>
        ) : null}

        {/* This month's sprint — S7: rendered from the STORED plan artifact on
            this report row (never recomputed), with last month's honest score. */}
        {data.sprintPlan ? (
          <>
            <Text style={styles.sectionTitle}>This Month&rsquo;s Sprint ({data.sprintPlan.period})</Text>
            {data.lastMonthSprintScore && data.lastMonthSprintScore.total > 0 ? (
              <Text style={{ fontSize: 9, color: "#444", marginBottom: 8 }}>
                Last month ({data.lastMonthSprintScore.period}): {data.lastMonthSprintScore.done} of{" "}
                {data.lastMonthSprintScore.total} planned actions completed.
              </Text>
            ) : null}
            {data.sprintPlan.fallback ? (
              <Text style={{ fontSize: 10, color: "#555" }}>
                {data.sprintPlan.fallbackReason ?? "Not enough live data — operator plan."}
              </Text>
            ) : (
              data.sprintPlan.weeks
                .filter((w) => w.items.length > 0)
                .map((w) => (
                  <View key={`sp-w${w.week}`} style={{ marginBottom: 8 }}>
                    <Text style={{ fontSize: 9, fontWeight: 700 }}>Week {w.week}</Text>
                    {w.items.map((item, i) => (
                      <View key={`sp-${w.week}-${i}`} style={styles.bulletRow}>
                        <Text style={styles.bullet}>•</Text>
                        <Text style={{ fontSize: 9 }}>
                          {item.title} — owner:{" "}
                          {item.owner === "netgrid_auto" ? "Netgrid auto" : "operator"}
                        </Text>
                      </View>
                    ))}
                  </View>
                ))
            )}
            <Text style={{ fontSize: 8, color: "#777", marginTop: 6 }}>
              {data.sprintPlan.contentDepthNote}
            </Text>
          </>
        ) : null}

        {/* S5 — the renewal one-liner (§E), only when real parity data exists;
            S2/S8 — open ledger counts consolidated under the sprint notes. */}
        {data.reviewParityLine ? (
          <Text style={{ fontSize: 9, color: "#444", marginTop: 8 }}>
            {data.reviewParityLine}
          </Text>
        ) : null}
        {data.hygieneNote ? (
          <Text style={{ fontSize: 8, color: "#777", marginTop: 4 }}>
            {data.hygieneNote}
          </Text>
        ) : null}

        {/* Footer */}
        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `Generated ${generatedAt} • NETGRID • Page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>

      {/* S4 — appendix page, ONLY when packs were actually sent to the client
          (§E: "appendix page when packs sent"; ready-but-unsent stays
          operator-side). Summarizes what was sent; the full copy-paste-ready
          packs live in the operator's printable cards. */}
      {data.gbpAppendix && data.gbpAppendix.packs.length > 0 ? (
        <Page size="LETTER" style={styles.page} wrap>
          <View style={styles.header}>
            <Text style={styles.brand}>NETGRID</Text>
            <Text style={styles.title}>Appendix — GBP Action Plan</Text>
            <Text style={styles.period}>
              {data.clientName}
              {data.gbpAppendix.sentOn ? ` — packs sent ${data.gbpAppendix.sentOn}` : ""}
            </Text>
          </View>
          {data.gbpAppendix.packs.map((pack, i) => (
            <View key={`ap-${i}`} style={{ marginBottom: 12 }}>
              <Text style={{ fontSize: 10, fontWeight: 700, marginBottom: 4 }}>
                {pack.title}
              </Text>
              {pack.lines.map((line, j) => (
                <View key={`apl-${i}-${j}`} style={styles.bulletRow}>
                  <Text style={styles.bullet}>•</Text>
                  <Text style={styles.bulletText}>{line}</Text>
                </View>
              ))}
            </View>
          ))}
          <Text style={{ fontSize: 8, color: "#777", marginTop: 8 }}>
            This appendix summarizes the Google Business Profile action packs your account
            manager walked you through — the full copy-paste-ready text lives with them.
          </Text>
          <Text
            style={styles.footer}
            fixed
            render={({ pageNumber, totalPages }) =>
              `Generated ${generatedAt} • NETGRID • Page ${pageNumber} of ${totalPages}`
            }
          />
        </Page>
      ) : null}
    </Document>
  );
};

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Render a monthly report row to a PDF buffer.
 *
 * Throws if the renderer can't produce output. Caller is responsible for
 * deciding whether to swallow + log (cron path) or surface (manual path).
 */
export async function renderReportPdf(data: ReportPdfData): Promise<Buffer> {
  const doc = <MonthlyReportDocument data={data} />;
  const instance = pdf(doc);
  // pdf().toBuffer() returns a stream in newer versions; toBlob() returns a Blob.
  // Use toBuffer when available, otherwise fall back to toBlob → arrayBuffer.
  if (typeof (instance as { toBuffer?: unknown }).toBuffer === "function") {
    const streamOrBuffer = await (instance as {
      toBuffer: () => Promise<Buffer | NodeJS.ReadableStream>;
    }).toBuffer();
    if (Buffer.isBuffer(streamOrBuffer)) return streamOrBuffer;
    // Stream path — collect chunks
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = streamOrBuffer as NodeJS.ReadableStream;
      stream.on("data", (chunk: Buffer | string) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  }
  // Fallback: toBlob → arrayBuffer
  const blob = await (instance as { toBlob: () => Promise<Blob> }).toBlob();
  const arrayBuf = await blob.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Build a safe filename for the attachment.
 * e.g. "Acme_Health_2026-04_report.pdf"
 */
export function reportPdfFilename(data: ReportPdfData): string {
  const safeClient = data.clientName
    .replace(/[^a-zA-Z0-9-_ ]+/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 40) || "client";
  const period = data.periodStart.slice(0, 7); // "YYYY-MM"
  return `${safeClient}_${period}_report.pdf`;
}
