/**
 * PDF renderer for GBP optimization packs (S4) — ONE PAGE PER PACK, built with
 * the same @react-pdf/renderer primitives as the monthly report (F5; no
 * Chromium dependency). The operator prints this and reads it on the client
 * call. Content is the already-generated pack payloads — this file only
 * renders, it never recomputes a fact.
 */

import * as React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  pdf,
} from "@react-pdf/renderer";

export interface GbpPackPdfRow {
  assetType: string;
  payload: unknown;
  createdAt: Date;
}

export interface GbpPackPdfData {
  clientName: string;
  packs: GbpPackPdfRow[];
}

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 9, fontFamily: "Helvetica" },
  header: { marginBottom: 10 },
  brand: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  meta: { fontSize: 8, color: "#555", marginTop: 2 },
  section: { marginBottom: 8 },
  sectionTitle: { fontSize: 11, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  line: { marginBottom: 3 },
  label: { fontFamily: "Helvetica-Bold" },
  footer: { marginTop: 12, fontSize: 7, color: "#777" },
});

function Lines({ rows }: { rows: Array<[string, string]> }) {
  return (
    <View>
      {rows
        .filter(([, v]) => (v ?? "").toString().trim() !== "")
        .map(([k, v], i) => (
          <Text key={i} style={styles.line}>
            <Text style={styles.label}>{k}: </Text>
            {String(v)}
          </Text>
        ))}
    </View>
  );
}

function typed(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

function PackPageContent({ payload }: { payload: unknown }) {
  const p = typed(payload);
  switch (true) {
    case "primary" in p: {
      // categories
      const primary = typed(p.primary);
      const secondary = Array.isArray(p.secondary) ? p.secondary : [];
      return (
        <View>
          <Lines
            rows={[
              ["Primary anchor", String(primary.anchor ?? "")],
              ["Why this order", String(primary.why ?? "")],
              ["GBP category", String(primary.gbpCategory ?? "")],
            ]}
          />
          {secondary.map((s, i) => {
            const row = typed(s);
            return (
              <Lines
                key={i}
                rows={[
                  [`Secondary ${i + 1} anchor`, String(row.anchor ?? "")],
                  [`Secondary ${i + 1} why`, String(row.why ?? "")],
                ]}
              />
            );
          })}
        </View>
      );
    }
    case Array.isArray(p) && p.length > 0 && "verdict" in typed(p[0]): {
      // attributes
      return (
        <View>
          {(p as unknown[]).map((raw, i) => {
            const row = typed(raw);
            return (
              <Text key={i} style={styles.line}>
                <Text style={styles.label}>[{String(row.verdict ?? "")}] </Text>
                {String(row.attribute ?? "")} — {String(row.why ?? "")}
              </Text>
            );
          })}
        </View>
      );
    }
    case "items" in p: {
      // services + cross-check
      const items = Array.isArray(p.items) ? p.items : [];
      const cross = typed(p.crossCheck);
      return (
        <View>
          {items.map((raw, i) => {
            const row = typed(raw);
            return (
              <Lines
                key={i}
                rows={[
                  [String(row.service ?? `Service ${i + 1}`), String(row.gbpDescription ?? "")],
                ]}
              />
            );
          })}
          <Lines
            rows={[
              ["On the website, missing on GBP", JSON.stringify(cross.onWebsiteMissingOnGbp ?? [])],
              ["On GBP, missing on website", JSON.stringify(cross.onGbpMissingOnWebsite ?? [])],
            ]}
          />
        </View>
      );
    }
    case "versions" in p: {
      // description A/B
      const versions = Array.isArray(p.versions) ? p.versions : [];
      return (
        <View>
          {versions.map((raw, i) => {
            const row = typed(raw);
            return (
              <Lines
                key={i}
                rows={[
                  [
                    `Version ${i + 1} (${String(row.chars ?? "")} chars, rotate on ${String(row.rotateOn ?? "").slice(0, 10)})`,
                    String(row.body ?? ""),
                  ],
                ]}
              />
            );
          })}
          <Text style={styles.line}>Measurement: {String(p.measurement ?? "")}</Text>
        </View>
      );
    }
    case "posts" in p: {
      const posts = Array.isArray(p.posts) ? p.posts : [];
      return (
        <View>
          <Text style={styles.line}>{String(p.areaRotationNote ?? "")}</Text>
          {posts.map((raw, i) => {
            const row = typed(raw);
            return (
              <View key={i} style={styles.section}>
                <Lines
                  rows={[
                    [
                      `Week ${String(row.week ?? i + 1)} (${String(row.publishOn ?? "").slice(0, 10)}, area: ${String(row.area ?? "")})`,
                      `${String(row.hook ?? "")} — ${String(row.body ?? "")} ${String(row.cta ?? "")}`,
                    ],
                    ["Photo", String(row.photo ?? "")],
                    [
                      "Links to",
                      String(row.targetUrl ?? "") || "not provided — pick the service page on the call",
                    ],
                  ]}
                />
              </View>
            );
          })}
        </View>
      );
    }
    case "queue" in p: {
      return (
        <View>
          <Text style={styles.line}>{String(p.audit ?? "")}</Text>
          <Text style={styles.line}>{String(p.target ?? "")}</Text>
          <Lines rows={[["Upload queue", (Array.isArray(p.queue) ? p.queue : []).join(", ")]]} />
        </View>
      );
    }
    case "bands" in p: {
      const bands = Array.isArray(p.bands) ? p.bands : [];
      return (
        <View>
          {bands.map((raw, i) => {
            const row = typed(raw);
            return (
              <Lines
                key={i}
                rows={[[`${String(row.band ?? "")} (${String(row.words ?? "")} words)`, String(row.template ?? "")]]}
              />
            );
          })}
          <Text style={styles.line}>{String(p.sla ?? "")}</Text>
        </View>
      );
    }
    default:
      return <Text>{JSON.stringify(p).slice(0, 2400)}</Text>;
  }
}

const PACK_TITLES: Record<string, string> = {
  categories: "1 · Categories",
  attributes: "2 · Attributes",
  services: "3 · Services",
  description: "4 · Business description A/B",
  posts: "5 · 8-week posts calendar",
  photos: "6 · Photos",
  reviews: "7 · Review responses",
};

function GbpPacksDocument({ data }: { data: GbpPackPdfData }) {
  return (
    <Document>
      {data.packs.map((pack) => (
        <Page key={pack.assetType} size="A4" style={styles.page}>
          <View style={styles.header}>
            <Text style={styles.brand}>
              {PACK_TITLES[pack.assetType] ?? pack.assetType} — {data.clientName}
            </Text>
            <Text style={styles.meta}>
              Generated {pack.createdAt.toISOString().slice(0, 10)} · copy-paste ready · every
              fact on this page is operator-verified; anything missing says so
            </Text>
          </View>
          <PackPageContent payload={pack.payload} />
          <Text style={styles.footer}>
            Netgrid never edits the Google Business Profile — everything here is pasted by the
            operator on the call.
          </Text>
        </Page>
      ))}
    </Document>
  );
}

/** Render one page per pack to a PDF buffer (same mechanics as
 * renderReportPdf). Throws on renderer failure — the route surfaces it. */
export async function renderGbpPacksPdf(data: GbpPackPdfData): Promise<Buffer> {
  const doc = <GbpPacksDocument data={data} />;
  const instance = pdf(doc);
  if (typeof (instance as { toBuffer?: unknown }).toBuffer === "function") {
    const streamOrBuffer = await (
      instance as { toBuffer: () => Promise<Buffer | NodeJS.ReadableStream> }
    ).toBuffer();
    if (Buffer.isBuffer(streamOrBuffer)) return streamOrBuffer;
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
  const blob = await (instance as { toBlob: () => Promise<Blob> }).toBlob();
  return Buffer.from(await blob.arrayBuffer());
}

export function gbpPdfFilename(clientName: string): string {
  const safe = clientName.replace(/[^a-zA-Z0-9-_ ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 40) || "client";
  return `${safe}_gbp_packs.pdf`;
}