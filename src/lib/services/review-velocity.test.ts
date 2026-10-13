// S5 DoD — the parity math exactly as documented, with every edge case the
// brief names as an explicit, honest state.

import { describe, expect, it } from "vitest";
import {
  historyMonths,
  monthsToParity,
  parseReviewDates,
  reviewRatePerMonth,
  renewalParityLine,
  withinSla,
  type ReviewHistory,
} from "./review-velocity";

const h = (dates: string[], totalCount: number | null = null): ReviewHistory => ({
  dates,
  totalCount,
});

describe("parseReviewDates — nothing is silently dropped", () => {
  it("keeps YYYY-MM-DD, separates the unparseable", () => {
    const { ok, bad } = parseReviewDates(["2026-08-01", "Aug 3", "2026-09-15", ""]);
    expect(ok).toEqual(["2026-08-01", "2026-09-15"]);
    expect(bad).toEqual(["Aug 3"]);
  });
});

describe("rate + history math", () => {
  it("months spanned is at least 1", () => {
    expect(historyMonths(["2026-08-01", "2026-08-20"])).toBe(1);
    expect(historyMonths(["2026-01-01", "2026-07-01"])).toBe(6);
  });

  it("a rate needs ≥2 dates — one point is a guess (F8)", () => {
    expect(reviewRatePerMonth(["2026-08-01"])).toBeNull();
    expect(reviewRatePerMonth(["2026-01-01", "2026-07-01"])).toBeCloseTo(2 / 6);
  });
});

describe("monthsToParity — the documented formula", () => {
  it("behind: ceil((their − ours) / max(1, theirRate − ourRate))", () => {
    const res = monthsToParity(
      // 4 dated reviews over 6 months (Jan→Jul) → 0.67/mo; total 10
      h(["2026-01-01", "2026-03-01", "2026-05-01", "2026-07-01"], 10),
      // 4 dated reviews over the same 6 months → 0.67/mo; total 4
      h(["2026-01-01", "2026-03-01", "2026-05-01", "2026-07-01"], 4),
    );
    expect(res.state).toBe("behind");
    expect(res.monthsToParity).toBe(6); // (10 − 4) / max(1, 0.67 − 0.67 → floor 1) = 6
    expect(res.estimate).toBe(false);
  });

  it("a faster our-side rate shortens parity; the denominator floor is 1", () => {
    const res = monthsToParity(
      h(["2026-01-01", "2026-07-01"], 12), // 2 dates / 6 mo = 0.33/mo
      h(["2026-01-01", "2026-02-01"], 4), // 2 dates / 1 mo = 2/mo
    );
    expect(res.state).toBe("behind");
    // The documented formula floors the rate gap at 1, so even when our rate
    // already beats theirs the count gap divides by 1: ceil((12 − 4)/1) = 8.
    expect(res.monthsToParity).toBe(8);
  });

  it("already ahead → maintain mode, no number", () => {
    const res = monthsToParity(
      h(["2026-01-01", "2026-02-01"], 5),
      h(["2026-01-01", "2026-02-01"], 9),
    );
    expect(res.state).toBe("maintain");
    expect(res.monthsToParity).toBeNull();
  });

  it("short history on either side → the number shows but labeled estimate", () => {
    const res = monthsToParity(
      h(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01"], 20),
      h(["2026-01-01", "2026-02-01"], 2),
    );
    expect(res.state).toBe("behind");
    expect(res.estimate).toBe(true);
  });

  it("missing dates on either side → NO number, only the gap list", () => {
    const res = monthsToParity(h(["2026-01-01", "2026-02-01"], 10), h([], null));
    expect(res.state).toBe("missing_data");
    expect(res.monthsToParity).toBeNull();
    expect(res.gaps.some((g) => g.includes("our review dates"))).toBe(true);
  });

  it("pasted totals carry the count when the dated sample is a handful", () => {
    const res = monthsToParity(
      h(["2026-01-01", "2026-02-01", "2026-03-01"], 30),
      h(["2026-01-01", "2026-02-01", "2026-03-01"], 6),
    );
    expect(res.theirCount).toBe(30);
    expect(res.ourCount).toBe(6);
  });
});

describe("SLA — measured only from real dates", () => {
  it("within 24h passes; an undated review can never claim the SLA", () => {
    const review = new Date("2026-09-20T10:00:00Z");
    expect(withinSla(new Date("2026-09-21T09:00:00Z"), review)).toBe(true);
    expect(withinSla(new Date("2026-09-21T11:00:00Z"), review)).toBe(false);
    expect(withinSla(new Date("2026-09-21T09:00:00Z"), null)).toBe(false);
  });
});

describe("renewalParityLine — the §E PDF one-liner (F8)", () => {
  const line = (dates: string[], total: number | null) => ({
    competitor: "Rival Plumbing",
    isTop: true,
    parity: monthsToParity(h(dates, total), h(["2026-01-01", "2026-03-01", "2026-05-01", "2026-07-01"], 10)),
  });

  it("behind → a line with the number and the counts", () => {
    const text = renewalParityLine({ ourHistory: { dates: [], totalCount: 10 }, lines: [line(["2026-01-01", "2026-03-01", "2026-05-01", "2026-07-01"], 22)] });
    expect(text).toContain("Rival Plumbing");
    expect(text).toContain("to parity");
    expect(text).toContain("ours 10 vs theirs 22");
  });

  it("ahead → the maintain-mode line, no number", () => {
    const text = renewalParityLine({
      ourHistory: { dates: [], totalCount: 4 },
      lines: [line(["2026-01-01", "2026-02-01"], 2)],
    });
    expect(text).toContain("maintain mode");
    expect(text).not.toContain("to parity");
  });

  it("missing data → null: the PDF omits the line instead of guessing", () => {
    expect(
      renewalParityLine({ ourHistory: null, lines: [line(["2026-01-01"], 5)] }),
    ).toBeNull();
    expect(renewalParityLine({ ourHistory: { dates: [], totalCount: 5 }, lines: [] })).toBeNull();
  });
});