"use client";

// S6 — Client SEO dossier editor (admin surface). Every save goes through
// saveClientDossier, which stamps last_verified_at; the read-only sections show
// what the merged view already knows so operators see context, not just fields.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveClientDossier } from "@/lib/actions/dossier-actions";

/** Serializable slice of DossierView — dates as ISO strings (React props). */
export interface DossierCardData {
  started: boolean;
  businessModel: string | null;
  serviceArea: string[];
  differentiators: string[];
  audience: string | null;
  recentWins: string[];
  gaps: string | null;
  lastVerifiedAt: string | null;
  staleWarning: string | null;
  competitorCount: number;
  topLivePairs: Array<{ query: string; avgPosition: number; impressions90d: number }>;
  openIssueCounts: Record<string, number>;
}

function linesToText(lines: string[]): string {
  return lines.join("\n");
}

function textToLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function DossierCard({
  clientId,
  data,
}: {
  clientId: string;
  data: DossierCardData | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [businessModel, setBusinessModel] = useState(data?.businessModel ?? "");
  const [serviceArea, setServiceArea] = useState(linesToText(data?.serviceArea ?? []));
  const [differentiators, setDifferentiators] = useState(
    linesToText(data?.differentiators ?? []),
  );
  const [audience, setAudience] = useState(data?.audience ?? "");
  const [recentWins, setRecentWins] = useState(linesToText(data?.recentWins ?? []));
  const [gaps, setGaps] = useState(data?.gaps ?? "");

  async function onSave() {
    startTransition(async () => {
      const res = await saveClientDossier(clientId, {
        businessModel: businessModel || null,
        serviceArea: textToLines(serviceArea),
        differentiators: textToLines(differentiators),
        audience: audience || null,
        recentWins: textToLines(recentWins),
        gaps: gaps || null,
      });
      if (res.ok) {
        toast.success("Dossier saved — freshness stamp updated.");
        router.refresh();
      } else {
        toast.error(res.error ?? "Failed to save dossier");
      }
    });
  }

  const verifiedDate = data?.lastVerifiedAt
    ? new Date(data.lastVerifiedAt).toLocaleDateString()
    : null;
  const openIssues = Object.entries(data?.openIssueCounts ?? {}).filter(
    ([, n]) => (n ?? 0) > 0,
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>Client SEO dossier</CardTitle>
          <CardDescription>
            The one fact sheet every generated artifact is grounded in. Missing
            fields stay &ldquo;not provided&rdquo; — nothing is invented. Saving stamps the
            freshness check.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {data?.staleWarning ? (
            <Badge variant="destructive">Stale &gt;90d</Badge>
          ) : data?.started ? (
            <Badge variant="secondary">Verified{verifiedDate ? ` ${verifiedDate}` : ""}</Badge>
          ) : (
            <Badge variant="outline">Not started</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {data?.staleWarning && (
          <p className="text-xs text-yellow-600">{data.staleWarning}</p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="dossier-business-model">Business model (what they sell &amp; how)</Label>
            <Textarea
              id="dossier-business-model"
              value={businessModel}
              onChange={(e) => setBusinessModel(e.target.value)}
              rows={3}
              placeholder="Operator-verified only — e.g. family plumbers, 24/7 emergency, own trucks…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dossier-audience">Audience (who buys, what they fear)</Label>
            <Textarea
              id="dossier-audience"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              rows={3}
              placeholder="Who buys, what they fear, what they compare us to…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dossier-service-area">Service area (one real place per line)</Label>
            <Textarea
              id="dossier-service-area"
              value={serviceArea}
              onChange={(e) => setServiceArea(e.target.value)}
              rows={3}
              placeholder={"Downtown\nRiverside"}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dossier-differentiators">Differentiators (one fact per line)</Label>
            <Textarea
              id="dossier-differentiators"
              value={differentiators}
              onChange={(e) => setDifferentiators(e.target.value)}
              rows={3}
              placeholder={"24/7 emergency service\nLicensed & insured since 1998"}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dossier-recent-wins">Recent wins (one per line)</Label>
            <Textarea
              id="dossier-recent-wins"
              value={recentWins}
              onChange={(e) => setRecentWins(e.target.value)}
              rows={3}
              placeholder={'Rescued "drain cleaning old town" from position 14 to 7'}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dossier-gaps">Gaps (honest &ldquo;we do not know&rdquo; list)</Label>
            <Textarea
              id="dossier-gaps"
              value={gaps}
              onChange={(e) => setGaps(e.target.value)}
              rows={3}
              placeholder={"No review history provided\nPricing unconfirmed"}
            />
          </div>
        </div>

        {data && (
          <div className="space-y-2 rounded-md border p-3 text-xs text-muted-foreground">
            <p>
              Competitor profiles:{" "}
              {data.competitorCount > 0 ? (
                <>
                  <strong>{data.competitorCount}</strong> pasted — managed in the GBP tab.
                </>
              ) : (
                "none yet (GBP tab)."
              )}
            </p>
            {openIssues.length > 0 && (
              <p>Open issues: {openIssues.map(([s, n]) => `${n} ${s}`).join(", ")}</p>
            )}
            {data.topLivePairs.length > 0 ? (
              <div>
                <p className="mb-1 font-medium">Top live queries (90d):</p>
                <ul className="list-disc pl-4">
                  {data.topLivePairs.map((p) => (
                    <li key={p.query}>
                      “{p.query}” @ position {Math.round(p.avgPosition * 10) / 10} (
                      {p.impressions90d} impressions)
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p>No Search Console data in the trailing window.</p>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={onSave} disabled={pending}>
            {pending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Save dossier
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}