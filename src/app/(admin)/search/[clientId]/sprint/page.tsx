import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { clients } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";
import {
  currentPeriodKey,
  getSprintProgress,
  type SprintItemStatus,
} from "@/lib/services/sprint-planner";
import { ManualItemToggle, RebuildSprintButton } from "@/components/search/sprint-plan-client";

export const dynamic = "force-dynamic";

/**
 * Sprint tab of the per-client GSC explorer (mega-prompt §S7 surface b): the
 * client's ACTIVE 30-day plan with live completion ticks as items resolve.
 * The plan is a stored artifact (reports.raw_data.sprint) built from live data
 * by the deterministic planner — this page only shows it and offers Rebuild.
 */
export default async function ClientSprintPage({
  params,
}: {
  params: { clientId: string };
}) {
  await requireAdmin();

  const [client] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.id, params.clientId))
    .limit(1);
  if (!client) notFound();

  // Fail-safe null (S6 pattern): an unreadable artifact degrades to the empty
  // state below instead of a 500 on the operator's planning surface.
  const progress = await getSprintProgress(client.id).catch(() => null);

  // Week items are stored plain; completion state lives in the flattened list,
  // so rows look their status up by stable id (ids never repeat within a plan).
  const itemStates = new Map(
    (progress?.items ?? []).map((i) => [i.id, i] as [string, SprintItemStatus]),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Link href={`/search/${client.id}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        {progress ? (
          <RebuildSprintButton clientId={client.id} />
        ) : null}
      </div>
      <div>
        <h1 className="text-2xl font-bold">This month&rsquo;s sprint</h1>
        <p className="text-muted-foreground">
          Week-by-week plan built from live data — open rescues first, then review
          issues, then location coverage. Items tick off as their machines resolve
          them; nothing here is invented to fill a week.
        </p>
      </div>

      {!progress ? (
        <Card>
          <CardHeader>
            <CardTitle>No active sprint for {currentPeriodKey(new Date())}</CardTitle>
            <CardDescription>
              A plan exists only when live data supports it: open page-2/pin rescues,
              folded/split/dead review issues, or pending location targets. Rebuild to
              generate one from the current state — a client with no signal at all gets
              an honest &ldquo;operator plan&rdquo; fallback instead of fabricated items.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <RebuildSprintButton clientId={client.id} />
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                Progress: {progress.doneCount} of {progress.totalCount} actions taken
              </CardTitle>
              <CardDescription>
                Plan period {progress.plan.period} · generated{" "}
                {progress.plan.generatedAt.slice(0, 10)} · ticks update live as issues
                resolve and the drip builds pages.
              </CardDescription>
            </CardHeader>
          </Card>

          {progress.plan.fallback ? (
            <Card>
              <CardContent className="text-sm text-muted-foreground">
                {progress.plan.fallbackReason}
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            {[...progress.plan.weeks]
              .sort((a, b) => a.week - b.week)
              .map((week) => (
                <Card key={week.week}>
                  <CardHeader>
                    <CardTitle className="text-base">Week {week.week}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {week.items.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No items ranked into this week.
                      </p>
                    ) : (
                      week.items.flatMap((item) => {
                        const st = itemStates.get(item.id);
                        return st ? [<SprintItemRow key={item.id} clientId={client.id} item={st} />] : [];
                      })
                    )}
                  </CardContent>
                </Card>
              ))}
          </div>

          <p className="text-xs text-muted-foreground">{progress.plan.contentDepthNote}</p>
        </>
      )}
    </div>
  );
}

function SprintItemRow({ clientId, item }: { clientId: string; item: SprintItemStatus }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{item.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {FAMILY_LABEL[item.family]} · owner:{" "}
          {item.owner === "netgrid_auto" ? "Netgrid auto" : "operator"}
        </p>
      </div>
      {item.family === "manual" && !item.done ? (
        <ManualItemToggle clientId={clientId} itemId={item.id} done={false} />
      ) : item.done ? (
        <Badge variant="secondary">Done{item.machineStatus ? ` · ${item.machineStatus}` : ""}</Badge>
      ) : (
        <Badge variant="outline">{item.machineStatus ?? "Open"}</Badge>
      )}
    </div>
  );
}

const FAMILY_LABEL: Record<SprintItemStatus["family"], string> = {
  rescue: "Rescue",
  "review-item": "Review issue",
  "location-page": "Location page",
  manual: "Manual / GBP",
};
