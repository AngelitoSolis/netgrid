import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GbpBuildButton } from "@/components/clients/gbp-build-button";
import { GbpPasteForm } from "@/components/clients/gbp-paste-form";
import { GbpApplyVersionButton } from "@/components/clients/gbp-apply-version-button";
import { GbpReviewHistoryForm } from "@/components/clients/gbp-review-history-form";
import { GbpLogResponseForm } from "@/components/clients/gbp-log-response-form";
import {
  latestGbpPacksForClient,
  listDescriptionVersions,
  type GbpAssetType,
} from "@/lib/services/gbp-packs";
import {
  reviewVelocityForClient,
  listReviewResponses,
  RESPONSE_SLA_HOURS,
  type CompetitorParityLine,
} from "@/lib/services/review-velocity";

// S4 — the GBP tab's read side. Renders the LATEST stored pack per type as a
// printable card (print CSS: only the packs survive Ctrl+P), the description
// A/B rotation table, and the competitor paste log. This component never
// recomputes pack content — it shows exactly what was stored (audit honesty).

function typed(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

const PACK_TITLES: Record<GbpAssetType, string> = {
  categories: "1 · Categories",
  attributes: "2 · Attributes",
  services: "3 · Services",
  description: "4 · Business description A/B",
  posts: "5 · 8-week posts calendar",
  photos: "6 · Photos",
  reviews: "7 · Review responses",
};
const PACK_ORDER = ["categories", "attributes", "services", "description", "posts", "photos", "reviews"] as const;

function PackBody({ payload }: { payload: unknown }) {
  const p = typed(payload);
  if ("primary" in p) {
    const primary = typed(p.primary);
    const secondary = Array.isArray(p.secondary) ? p.secondary.map(typed) : [];
    return (
      <div className="space-y-1 text-sm">
        <p><span className="font-medium">Primary anchor:</span> {String(primary.anchor ?? "")}</p>
        <p className="text-muted-foreground">{String(primary.why ?? "")}</p>
        <p><span className="font-medium">GBP category:</span> {String(primary.gbpCategory ?? "")}</p>
        {secondary.map((s, i) => (
          <p key={i} className="text-muted-foreground">
            Secondary: {String(s.anchor ?? "")} — {String(s.why ?? "")}
          </p>
        ))}
      </div>
    );
  }
  if (Array.isArray(p) && p.length > 0 && "verdict" in typed(p[0])) {
    return (
      <ul className="space-y-1 text-sm">
        {(p as unknown[]).map((raw, i) => {
          const row = typed(raw);
          return (
            <li key={i}>
              <Badge variant={row.verdict === "keep" ? "default" : "outline"} className="mr-2">
                {String(row.verdict ?? "")}
              </Badge>
              {String(row.attribute ?? "")}
              <span className="text-muted-foreground"> — {String(row.why ?? "")}</span>
            </li>
          );
        })}
      </ul>
    );
  }
  if ("items" in p) {
    const items = Array.isArray(p.items) ? p.items.map(typed) : [];
    const cross = typed(p.crossCheck);
    return (
      <div className="space-y-2 text-sm">
        {items.map((row, i) => (
          <p key={i}>
            <span className="font-medium">{String(row.service ?? "")}</span>{" "}
            <span className="text-muted-foreground">({String(row.words ?? "")} words)</span>:{" "}
            {String(row.gbpDescription ?? "")}
          </p>
        ))}
        <p className="text-muted-foreground">
          On the website, missing on GBP: {JSON.stringify(cross.onWebsiteMissingOnGbp ?? [])} · On GBP,
          missing on website: {JSON.stringify(cross.onGbpMissingOnWebsite ?? [])}
        </p>
      </div>
    );
  }
  if ("versions" in p) {
    const versions = Array.isArray(p.versions) ? p.versions.map(typed) : [];
    return (
      <div className="space-y-2 text-sm">
        {versions.map((v, i) => (
          <p key={i}>
            <span className="font-medium">Version {i + 1}</span>{" "}
            <span className="text-muted-foreground">
              ({String(v.chars ?? "")} chars, rotate on {String(v.rotateOn ?? "").slice(0, 10)})
            </span>
            : {String(v.body ?? "")}
          </p>
        ))}
        <p className="text-muted-foreground">Measurement: {String(p.measurement ?? "")}</p>
      </div>
    );
  }
  if ("posts" in p) {
    const posts = Array.isArray(p.posts) ? p.posts.map(typed) : [];
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">{String(p.areaRotationNote ?? "")}</p>
        {posts.map((row, i) => (
          <p key={i}>
            <span className="font-medium">
              W{String(row.week ?? i + 1)} · {String(row.area ?? "")}
            </span>{" "}
            {String(row.hook ?? "")} — {String(row.body ?? "")}{" "}
            <span className="text-muted-foreground">
              Photo: {String(row.photo ?? "")} · Links to:{" "}
              {String(row.targetUrl ?? "") || "not provided — pick the service page on the call"}
            </span>
          </p>
        ))}
      </div>
    );
  }
  if ("queue" in p) {
    return (
      <div className="space-y-1 text-sm">
        <p>{String(p.audit ?? "")}</p>
        <p>{String(p.target ?? "")}</p>
        <p className="text-muted-foreground">Queue: {(Array.isArray(p.queue) ? p.queue : []).join(", ")}</p>
      </div>
    );
  }
  if ("bands" in p) {
    const bands = Array.isArray(p.bands) ? p.bands.map(typed) : [];
    return (
      <div className="space-y-2 text-sm">
        {bands.map((row, i) => (
          <p key={i}>
            <span className="font-medium">{String(row.band ?? "")}</span>{" "}
            <span className="text-muted-foreground">({String(row.words ?? "")} words)</span>:{" "}
            {String(row.template ?? "")}
          </p>
        ))}
        <p className="text-muted-foreground">{String(p.sla ?? "")}</p>
      </div>
    );
  }
  return <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(p, null, 2)}</pre>;
}

export async function GbpPanel({
  clientId,
  competitors,
}: {
  clientId: string;
  competitors: Array<{ name: string; category: string | null; reviewCount: number | null }>;
}) {
  const [packs, versions] = await Promise.all([
    latestGbpPacksForClient(clientId),
    listDescriptionVersions(clientId),
  ]);
  const byType = new Map(packs.map((p) => [p.assetType, p]));
  const [velocity, responses] = await Promise.all([
    reviewVelocityForClient(clientId).catch(() => ({ ourHistory: null, lines: [] as CompetitorParityLine[] })),
    listReviewResponses(clientId).catch(() => []),
  ]);

  return (
    <div className="space-y-6 pt-4">
      <Card className="print:hidden">
        <CardHeader>
          <CardTitle>Competitor paste</CardTitle>
          <CardDescription>
            One paste per competitor on the call. Facts land in the client dossier; anything
            you skip renders as &ldquo;not provided — ask on next call&rdquo;, never invented.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <GbpPasteForm clientId={clientId} />
          {competitors.length > 0 && (
            <div className="space-y-1 text-sm">
              <p className="font-medium">On file</p>
              {competitors.map((c) => (
                <p key={c.name} className="text-muted-foreground">
                  {c.name}
                  {c.category ? ` · ${c.category}` : ""}
                  {c.reviewCount !== null ? ` · ${c.reviewCount} reviews` : ""}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between print:hidden">
        <p className="text-sm text-muted-foreground">
          Packs are insert-only — every rebuild keeps the old rows as the record of what was
          promised.
        </p>
        <div className="flex gap-2">
          <a
            href={`/api/clients/${clientId}/gbp/pdf`}
            className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
          >
            Download PDF (one page per pack)
          </a>
          <GbpBuildButton clientId={clientId} />
        </div>
      </div>

      {packs.length === 0 ? (
        <Card className="print:hidden">
          <CardContent className="py-6 text-sm text-muted-foreground">
            No packs built yet — paste a competitor, then build. That is an empty state, not a
            failure.
          </CardContent>
        </Card>
      ) : (
        PACK_ORDER.filter((t) => byType.has(t as GbpAssetType)).map((t) => {
          const pack = byType.get(t as GbpAssetType)!;
          return (
            <Card key={t} className="break-inside-avoid-page">
              <CardHeader>
                <CardTitle className="text-base">
                  {PACK_TITLES[pack.assetType]}
                </CardTitle>
                <CardDescription>
                  Built {new Date(pack.createdAt).toISOString().slice(0, 10)} ·{" "}
                  {pack.status === "ready" ? "ready" : pack.status}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <PackBody payload={pack.payload} />
              </CardContent>
            </Card>
          );
        })
      )}

      {versions.length > 0 && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle className="text-base">Description rotation</CardTitle>
            <CardDescription>
              750-character cap enforced before insert. Mark a version live once the operator
              confirms it on the GBP; measurement notes only ever come from real brand-query
              data — until then: no measurable signal yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {versions.map((v) => (
              <div key={v.id} className="space-y-1 rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    v{v.version} · {v.body.length} chars
                    {v.appliedAt ? ` · live since ${new Date(v.appliedAt).toISOString().slice(0, 10)}` : ""}
                  </p>
                  <GbpApplyVersionButton clientId={clientId} versionId={v.id} applied={Boolean(v.appliedAt)} />
                </div>
                <p className="text-sm text-muted-foreground">{v.body}</p>
                {v.performanceNote && (
                  <p className="text-xs text-muted-foreground">Measured: {v.performanceNote}</p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* S5 — review velocity + response SLA. COMPUTED, not generated: the
          number comes from pasted date history by the documented formula, and
          every edge case says exactly what it is. */}
      <Card className="print:hidden">
        <CardHeader>
          <CardTitle className="text-base">Review velocity — months to parity</CardTitle>
          <CardDescription>
            Computed from pasted review-date history (never estimated silently): fewer than 6
            months of dates on either side shows the number labeled as an estimate; missing
            dates show a gap list instead of a number.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm font-medium mb-1">Our review history</p>
            {velocity.ourHistory ? (
              <p className="text-xs text-muted-foreground">
                {velocity.ourHistory.dates.length} dated review
                {velocity.ourHistory.dates.length === 1 ? "" : "s"} on file
                {velocity.ourHistory.totalCount !== null
                  ? ` · total count ${velocity.ourHistory.totalCount}`
                  : ""}{" "}
                (saved {velocity.ourHistory.createdAt.toISOString().slice(0, 10)})
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Not pasted yet.</p>
            )}
            <div className="mt-2">
              <GbpReviewHistoryForm clientId={clientId} />
            </div>
          </div>

          {velocity.lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No competitor with pasted review dates yet — the parity number needs both sides.
            </p>
          ) : (
            <div className="space-y-2">
              {velocity.lines.map((line) => (
                <div key={line.competitor} className="rounded-md border p-3 text-sm">
                  <p className="font-medium">
                    vs {line.competitor}
                    {line.isTop ? " · top competitor" : ""}
                  </p>
                  {line.parity.state === "maintain" && (
                    <p className="text-muted-foreground">
                      Maintain mode — we are at or ahead ({line.parity.ourCount} vs{" "}
                      {line.parity.theirCount}). Keep posting at ≥ their rate.
                    </p>
                  )}
                  {line.parity.state === "behind" && (
                    <p className="text-muted-foreground">
                      ~{line.parity.monthsToParity} month
                      {line.parity.monthsToParity === 1 ? "" : "s"} to parity
                      {line.parity.estimate ? " — estimate (short history)" : ""} (ours{" "}
                      {line.parity.ourCount} vs theirs {line.parity.theirCount}; rates{" "}
                      {line.parity.ourRate?.toFixed(1)}/mo vs {line.parity.theirRate?.toFixed(1)}/mo)
                    </p>
                  )}
                  {line.parity.state === "missing_data" && (
                    <ul className="list-disc pl-5 text-muted-foreground">
                      {line.parity.gaps.map((g) => (
                        <li key={g}>{g}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="print:hidden">
        <CardHeader>
          <CardTitle className="text-base">Response SLA — {RESPONSE_SLA_HOURS}h first response</CardTitle>
          <CardDescription>
            The standard: every review answered within {RESPONSE_SLA_HOURS} hours; templates are in
            pack 7. The log is the renewal-conversation proof — it only ever counts what was
            actually logged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <GbpLogResponseForm clientId={clientId} />
          {responses.length === 0 ? (
            <p className="text-sm text-muted-foreground">No responses logged yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {responses.map((r, i) => (
                <li key={i} className="text-muted-foreground">
                  {String(r.reviewRef)} — responded {String(r.respondedAt).slice(0, 10)}
                  {r.notes ? ` · ${String(r.notes)}` : ""}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Renewal line: {responses.length} review response{responses.length === 1 ? "" : "s"} logged;
            target ≤{RESPONSE_SLA_HOURS}h first response on every review.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}