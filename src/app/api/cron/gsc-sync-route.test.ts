// Route-level gsc-sync tests (R7 / §I.6). No separate page2-rescue or
// rescue-outcomes cron routes exist — the fold into THIS route is the trigger,
// so the §I.6 failing-shard requirement lands here: one blog's pass throwing
// must never kill the run — the failure is isolated, the metrics reflect only
// what succeeded, and every remaining blog still processes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyCronSecret: vi.fn(),
  runGscSync: vi.fn(),
  provisionPendingProperties: vi.fn(),
  findSuppressedBlogs: vi.fn(),
  sendSuppressedBlogsAlert: vi.fn(),
  runDossierFreshnessCheck: vi.fn(),
  checkDescriptionRotation: vi.fn(),
  runPage2RescueForBlog: vi.fn(),
  runPage2RescueOutcomes: vi.fn(),
  runQueryHygieneForBlog: vi.fn(),
  hygieneLedgerTelemetry: vi.fn(),
  autoFixIssuesForScan: vi.fn(),
  rescanBlogScore: vi.fn(),
  selectQueue: [] as unknown[][],
}));

vi.mock("@/lib/auth/helpers", () => ({ verifyCronSecret: mocks.verifyCronSecret }));
vi.mock("@/lib/services/gsc-sync", () => ({
  runGscSync: mocks.runGscSync,
  findSuppressedBlogs: mocks.findSuppressedBlogs,
  sendSuppressedBlogsAlert: mocks.sendSuppressedBlogsAlert,
}));
vi.mock("@/lib/services/gsc-verifier", () => ({
  provisionPendingProperties: mocks.provisionPendingProperties,
}));
vi.mock("@/lib/services/client-dossier", () => ({
  runDossierFreshnessCheck: mocks.runDossierFreshnessCheck,
}));
vi.mock("@/lib/services/gbp-packs", () => ({
  checkDescriptionRotation: mocks.checkDescriptionRotation,
}));
vi.mock("@/lib/services/page2-rescue", () => ({
  runPage2RescueForBlog: mocks.runPage2RescueForBlog,
  runPage2RescueOutcomes: mocks.runPage2RescueOutcomes,
  RESCUE_MAX_APPLIED_NETWORK: 25,
}));
vi.mock("@/lib/services/query-hygiene", () => ({
  runQueryHygieneForBlog: mocks.runQueryHygieneForBlog,
  hygieneLedgerTelemetry: mocks.hygieneLedgerTelemetry,
}));
vi.mock("@/lib/services/seo-autofix", () => ({
  autoFixIssuesForScan: mocks.autoFixIssuesForScan,
  rescanBlogScore: mocks.rescanBlogScore,
}));
// The route's only direct db use is the queued-rescue drain SELECT — queued=[]
// keeps the apply path out of these tests (autoFixIssuesForScan is the unit
// that owns it and is exercised by its own suite).
vi.mock("@/lib/db", () => ({
  db: {
    select: () => {
      const rows = mocks.selectQueue.shift() ?? [];
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (
          resolve: (rows: unknown[]) => unknown,
          reject?: (e: unknown) => unknown,
        ) => Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
  },
}));

import { GET } from "./gsc-sync/route";

function zeroedHygieneMetrics() {
  return { split: 0, folded: 0, pin: 0, dead: 0, opened: 0, skippedExisting: 0, generated: 0 };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verifyCronSecret.mockReturnValue(true);
  mocks.runGscSync.mockResolvedValue({
    configured: true,
    results: [
      { blogId: "b1", clientId: "c1" },
      { blogId: "b2", clientId: "c2" },
    ],
  });
  mocks.runPage2RescueForBlog.mockResolvedValue({
    detected: 1,
    opened: 1,
    skippedExisting: 0,
    generated: 0,
  });
  mocks.runQueryHygieneForBlog.mockResolvedValue(zeroedHygieneMetrics());
  mocks.runPage2RescueOutcomes.mockResolvedValue({ measured: 0, resolved: 0 });
  mocks.checkDescriptionRotation.mockResolvedValue({ due: false, daysSinceApplied: null });
  mocks.runDossierFreshnessCheck.mockResolvedValue({
    verified: 1,
    stale: 0,
    neverVerified: 0,
    clients: 2,
  });
  mocks.hygieneLedgerTelemetry.mockResolvedValue({
    open: { split: 0, folded: 0, pin: 0, dead: 0 },
    decided: { split: 0, folded: 0, pin: 0, dead: 0 },
  });
});

describe("gsc-sync cron — the fold point is failing-shard safe (§I.6)", () => {
  it("one blog's rescue pass throwing does not kill the run: counted, isolated, remaining blogs processed", async () => {
    mocks.runPage2RescueForBlog
      .mockRejectedValueOnce(new Error("GSC pool exploded for b1"))
      .mockResolvedValueOnce({ detected: 1, opened: 1, skippedExisting: 0, generated: 0 });

    const res = await GET(new Request("http://localhost/api/cron/gsc-sync"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Both blogs were CONSIDERED; only the healthy one contributed metrics.
    expect(body.rescue.considered).toBe(2);
    expect(body.rescue.detected).toBe(1);
    // The hygiene pass still ran for BOTH blogs after the rescue failure.
    expect(body.hygiene.considered).toBe(2);
    expect(mocks.runQueryHygieneForBlog).toHaveBeenCalledTimes(2);
    // The run completed to the end (rotation + freshness + response JSON).
    expect(body.gbpRotation).toEqual({ checked: 2, due: 0 });
    expect(body.dossierFreshness).toMatchObject({ clients: 2 });
  });

  it("one blog's hygiene pass throwing is isolated the same way", async () => {
    mocks.runQueryHygieneForBlog
      .mockResolvedValueOnce({ ...zeroedHygieneMetrics(), split: 1 })
      .mockRejectedValueOnce(new Error("hygiene exploded for b2"));

    const res = await GET(new Request("http://localhost/api/cron/gsc-sync"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hygiene.considered).toBe(1);
    expect(body.hygiene.split).toBe(1);
    // The rescue metrics were untouched by the hygiene failure.
    expect(body.rescue.considered).toBe(2);
    expect(body.rescue.detected).toBe(2);
  });

  it("the telemetry read failing leaves zeroed open/decided counts and a 200", async () => {
    mocks.hygieneLedgerTelemetry.mockRejectedValueOnce(new Error("telemetry down"));
    const res = await GET(new Request("http://localhost/api/cron/gsc-sync"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hygiene.open).toEqual({ split: 0, folded: 0, pin: 0, dead: 0 });
    expect(body.hygiene.decided).toEqual({ split: 0, folded: 0, pin: 0, dead: 0 });
  });

  it("a bad cron secret is a 401 before anything runs", async () => {
    mocks.verifyCronSecret.mockReturnValueOnce(false);
    const res = await GET(new Request("http://localhost/api/cron/gsc-sync"));
    expect(res.status).toBe(401);
    expect(mocks.runGscSync).not.toHaveBeenCalled();
  });

  it("an unconfigured environment short-circuits the loop but still 200s", async () => {
    mocks.runGscSync.mockResolvedValueOnce({ configured: false, results: [] });
    const res = await GET(new Request("http://localhost/api/cron/gsc-sync"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rescue.considered).toBe(0);
    expect(body.dossierFreshness).toMatchObject({ clients: 2 }); // freshness always runs
  });
});