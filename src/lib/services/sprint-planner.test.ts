// S7 sprint engine — deterministic planner core (DoD: fixture client week
// assignments match hand-computed expectations EXACTLY; re-runs are idempotent
// on period; zero-signal clients get an honest fallback, never fabricated items).

import { describe, expect, it } from "vitest";
import {
  assembleSprintPlan,
  currentPeriodKey,
  flattenPlanItems,
  normalizeManualNotes,
  priorPeriodKey,
  SPRINT_ITEMS_PER_WEEK,
  type LocationGapCandidate,
  type MonthlySprintPlan,
  type RescueCandidate,
  type ReviewIssueCandidate,
  type SprintInputs,
} from "./sprint-planner";

const FIXED_NOW = new Date(2026, 8, 15); // mid-September 2026 → period "2026-09"

function rescue(issueId: string, query: string, impressions90dBefore: number | null): RescueCandidate {
  return { issueId, query, pageUrl: `https://example.com/${issueId}`, impressions90dBefore };
}

function review(
  issueId: string,
  familyKey: "folded" | "split" | "dead",
  severity: "critical" | "warning" | "notice",
  title = "Review item",
): ReviewIssueCandidate {
  return { issueId, familyKey, severity, title, pageUrl: `https://example.com/${issueId}` };
}

function gap(targetId: string, keyword: string, priority: number | null): LocationGapCandidate {
  return { targetId, keyword, city: "Melbourne", priority };
}

/** The hand-computed fixture: 3 rescues + 2 reviews + 3 gaps + 4 raw notes. */
function fixtureInputs(): SprintInputs {
  return {
    clientId: "client-fixture",
    now: FIXED_NOW,
    openRescues: [
      rescue("iss-r3", "alpha query", null),
      rescue("iss-r1", "beta query", 120),
      rescue("iss-r2", "gamma query", 500),
    ],
    reviewItems: [
      review("iss-v2", "split", "notice", "Two pages rank for the same query"),
      review("iss-v1", "folded", "critical", "Canonical disagrees with declared URL"),
    ],
    locationGaps: [
      gap("tgt-3", "roofing melbourne", null),
      gap("tgt-1", "plumbing melbourne", 2),
      gap("tgt-2", "drainage melbourne", 2),
    ],
    manualNotes: [
      "   Paste competitor reviews into the GBP tab ",
      "",
      "paste COMPETITOR reviews into the gbp tab",
      "Confirm photo upload schedule with client",
    ],
  };
}

function idsInWeek(plan: MonthlySprintPlan, week: number): string[] {
  return plan.weeks.find((w) => w.week === week)?.items.map((i) => i.id) ?? [];
}

describe("assembleSprintPlan — hand-computed fixture", () => {
  it("assigns weeks exactly as the documented comparator says (W1 full, W2 partial)", () => {
    const plan = assembleSprintPlan(fixtureInputs());
    expect(plan.fallback).toBe(false);
    expect(plan.period).toBe("2026-09");

    // Rank 0–4: rescues by impressions DESC NULLS LAST, then critical review.
    expect(idsInWeek(plan, 1)).toEqual([
      "rescue:iss-r2", // 500 imp — highest first
      "rescue:iss-r1", // 120 imp
      "rescue:iss-r3", // null impressions — NULLS LAST
      "review-item:iss-v1", // critical folded beats notice split
      "review-item:iss-v2",
    ]);
    // Rank 5–9: gaps by priority ASC (tie → keyword asc), then manual notes.
    expect(idsInWeek(plan, 2)).toEqual([
      "location-page:tgt-2", // priority 2, "drainage" < "plumbing"
      "location-page:tgt-1", // priority 2
      "location-page:tgt-3", // null priority — NULLS LAST
      "manual:paste-competitor-reviews-into-the-gbp-tab",
      "manual:confirm-photo-upload-schedule-with-client",
    ]);
    expect(idsInWeek(plan, 3)).toEqual([]);
    expect(idsInWeek(plan, 4)).toEqual([]);

    // Owners + hooks come from the family.
    const first = plan.weeks[0].items[0];
    expect(first.owner).toBe("netgrid_auto");
    expect(first.hook).toBe("rescue:iss-r2");
    expect(plan.weeks[0].items[3].owner).toBe("operator");
    expect(plan.weeks[1].items[3].hook.startsWith("manual:")).toBe(true);
  });

  it("is deterministic — identical inputs give a byte-identical plan", () => {
    const a = assembleSprintPlan(fixtureInputs());
    const b = assembleSprintPlan(fixtureInputs());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("is idempotent on period — any date inside the month plans the same period", () => {
    const base = fixtureInputs();
    for (const day of [1, 10, 30]) {
      const plan = assembleSprintPlan({ ...base, now: new Date(2026, 8, day) });
      expect(plan.period).toBe("2026-09");
      expect(flattenPlanItems(plan).map((i) => i.id)).toEqual(
        flattenPlanItems(assembleSprintPlan(base)).map((i) => i.id),
      );
    }
  });

  it("truncates beyond 4×5 slots deterministically", () => {
    const many: RescueCandidate[] = [];
    for (let i = 0; i < 23; i++) {
      many.push(rescue(`iss-p${String(i).padStart(2, "0")}`, `query ${i}`, 1000 - i * 10));
    }
    const plan = assembleSprintPlan({ ...fixtureInputs(), openRescues: many });
    expect(plan.weeks.every((w) => w.items.length <= SPRINT_ITEMS_PER_WEEK)).toBe(true);
    const flat = flattenPlanItems(plan);
    expect(flat).toHaveLength(20);
    // Rank 19 is the last slot; rank 20 (iss-p20) never made it.
    expect(flat[flat.length - 1].id).toBe("rescue:iss-p19");
    expect(flat.some((i) => i.id === "rescue:iss-p20")).toBe(false);
  });

  it("gives a zero-signal client an honest operator-plan fallback, never fabricated items", () => {
    const plan = assembleSprintPlan({
      clientId: "client-empty",
      now: FIXED_NOW,
      openRescues: [],
      reviewItems: [],
      locationGaps: [],
      manualNotes: ["   ", ""],
    });
    expect(plan.fallback).toBe(true);
    expect(plan.fallbackReason?.toLowerCase()).toContain("operator plan");
    expect(flattenPlanItems(plan)).toHaveLength(0);
    expect(plan.weeks).toHaveLength(4);
  });

  it("orders review items by severity first, family second (folded < split < dead)", () => {
    const plan = assembleSprintPlan({
      clientId: "client-sev",
      now: FIXED_NOW,
      openRescues: [],
      reviewItems: [
        review("iss-s3", "dead", "notice"),
        review("iss-s1", "split", "critical"),
        review("iss-s2", "folded", "critical"),
      ],
      locationGaps: [],
      manualNotes: [],
    });
    expect(idsInWeek(plan, 1)).toEqual([
      "review-item:iss-s2", // critical + folded family wins the tie vs split
      "review-item:iss-s1",
      "review-item:iss-s3",
    ]);
  });

  it("prints the explicit W2 content-depth note on every non-fallback plan", () => {
    const plan = assembleSprintPlan(fixtureInputs());
    expect(plan.contentDepthNote).toContain("meta");
    expect(plan.contentDepthNote.toLowerCase()).toContain("faq");
    const fallback = assembleSprintPlan({
      clientId: "x",
      now: FIXED_NOW,
      openRescues: [],
      reviewItems: [],
      locationGaps: [],
      manualNotes: [],
    });
    expect(fallback.contentDepthNote).toBe(plan.contentDepthNote);
  });

  it("flattenPlanItems preserves week order", () => {
    const plan = assembleSprintPlan(fixtureInputs());
    expect(flattenPlanItems(plan).map((i) => i.id)).toEqual([
      ...idsInWeek(plan, 1),
      ...idsInWeek(plan, 2),
    ]);
  });
});

describe("period key helpers", () => {
  it("currentPeriodKey is YYYY-MM of the given month", () => {
    expect(currentPeriodKey(new Date(2026, 8, 5))).toBe("2026-09");
    expect(currentPeriodKey(new Date(2026, 0, 31))).toBe("2026-01");
  });

  it("priorPeriodKey rolls back across the year boundary", () => {
    expect(priorPeriodKey(new Date(2026, 8, 5))).toBe("2026-08");
    expect(priorPeriodKey(new Date(2026, 0, 10))).toBe("2025-12");
  });
});

describe("normalizeManualNotes", () => {
  it("trims, drops blanks and dedupes case-insensitively", () => {
    expect(
      normalizeManualNotes(["  a b  ", "A B", "", null as unknown as string, "c d"]),
    ).toEqual(["a b", "c d"]);
  });

  it("caps stored lines at 300 chars without throwing", () => {
    const out = normalizeManualNotes(["x".repeat(500)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(300);
  });
});

