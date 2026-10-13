// R7 wiring tests for the monthly-report engine (§I.6): the sprint artifact is
// STORED on the report row for the period, the PDF data carries every §E
// section, the GBP appendix appears ONLY when a pack was actually sent to the
// client (F8 — ready-but-unsent never renders), and the hygiene note omits
// while the open ledger is all-zero.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getClientScope: vi.fn(),
  generateMonthlyReport: vi.fn(),
  logActivity: vi.fn(),
  sendReportPdfEmail: vi.fn(),
  listRescueOutcomes: vi.fn(),
  locationCoverageForPeriod: vi.fn(),
  serviceTermsForClient: vi.fn(),
  getDossierForClient: vi.fn(),
  buildDossierContextBlock: vi.fn(),
  renderReportPdf: vi.fn(),
  reviewVelocityForClient: vi.fn(),
  buildMonthlySprint: vi.fn(),
  readStoredSprint: vi.fn(),
  scoreStoredSprint: vi.fn(),
  findTopicalLinkRefs: vi.fn(),
  generateProposalForFinding: vi.fn(),
}));

vi.mock("server-only", () => ({}));

// Table-keyed FIFO fake: each table holds one ROWS-PER-CALL queue, consumed in
// exact call order — generateReportInternal and emailReportPdfInternal have
// deterministic select sequences. The state lives in vi.hoisted so the hoisted
// vi.mock factory below can close over it without touching module TDZ.
const h = vi.hoisted(() => {
  const tables = new Map<string, unknown[][]>();
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  return { tables, inserts };
});
function queue(table: string, rowsPerCall: unknown[][]): void {
  h.tables.set(table, rowsPerCall);
}
vi.mock("@/lib/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  return {
    db: {
      select: () => {
        let from = "";
        const chain = {
          from: (t: unknown) => {
            from = getTableName(t as never);
            return chain;
          },
          where: () => chain,
          orderBy: () => chain,
          limit: () => chain,
          then: (
            resolve: (rows: unknown[]) => unknown,
            reject?: (e: unknown) => unknown,
          ) => {
            const q = h.tables.get(from) ?? [];
            const rows = q.shift() ?? [];
            return Promise.resolve(rows).then(resolve, reject);
          },
        };
        return chain;
      },
      insert: (t: unknown) => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            h.inserts.push({ table: getTableName(t as never), values: v });
            return [{ id: "report-new", ...v }];
          },
        }),
      }),
      update: () => {
        throw new Error("report-actions tests do not exercise updates");
      },
    },
  };
});
vi.mock("@/lib/auth/helpers", () => ({
  requireAdmin: mocks.requireAdmin,
  getClientScope: mocks.getClientScope,
}));
vi.mock("@/lib/services/claude-client", () => ({
  generateMonthlyReport: mocks.generateMonthlyReport,
}));
vi.mock("@/lib/services/activity-logger", () => ({ logActivity: mocks.logActivity }));
vi.mock("@/lib/services/email", () => ({ sendReportPdfEmail: mocks.sendReportPdfEmail }));
vi.mock("@/lib/services/page2-rescue", () => ({
  listRescueOutcomes: mocks.listRescueOutcomes,
  generateProposalForFinding: mocks.generateProposalForFinding,
  normalizeForMatch: (u: string) => u.toLowerCase(),
  RESCUE_MAX_GENERATED_PER_RUN: 5,
}));
vi.mock("@/lib/services/location-matrix", () => ({
  locationCoverageForPeriod: mocks.locationCoverageForPeriod,
  serviceTermsForClient: mocks.serviceTermsForClient,
}));
vi.mock("@/lib/services/client-dossier", () => ({
  getDossierForClient: mocks.getDossierForClient,
  buildDossierContextBlock: mocks.buildDossierContextBlock,
}));
vi.mock("@/lib/services/semantic-linking", () => ({
  findTopicalLinkRefs: mocks.findTopicalLinkRefs,
}));
// renderReportPdf CAPTURES the assembled ReportPdfData — the tests assert on
// exactly what the PDF would have rendered.
const capturedPdfData: unknown[] = [];
vi.mock("@/lib/services/pdf-renderer", () => ({
  renderReportPdf: mocks.renderReportPdf,
  reportPdfFilename: () => "report.pdf",
}));
vi.mock("@/lib/services/review-velocity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reviewVelocityForClient: mocks.reviewVelocityForClient,
}));
vi.mock("@/lib/services/sprint-planner", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildMonthlySprint: mocks.buildMonthlySprint,
  scoreStoredSprint: mocks.scoreStoredSprint,
}));

import {
  emailReportPdfInternal,
  generateReportForCron,
} from "./report-actions";

const CLIENT = "c1";
const PLAN = {
  clientId: CLIENT,
  periodKey: "2026-08",
  weeks: [],
  overrides: { manualDone: [] },
  generatedAt: "2026-08-01T00:00:00.000Z",
} as never;
const LAST_MONTH_SCORE = { period: "2026-07", done: 3, total: 5 };

const REPORT_ROW = {
  id: "r1",
  clientId: CLIENT,
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  // The PDF reads the STORED sprint artifact from this row — never a recompute.
  rawData: { sprint: PLAN },
};

beforeEach(() => {
  vi.resetAllMocks();
  h.tables.clear();
  h.inserts.length = 0;
  capturedPdfData.length = 0;
  mocks.renderReportPdf.mockImplementation(async (data: unknown) => {
    capturedPdfData.push(data);
    return Buffer.from("pdf");
  });
  mocks.sendReportPdfEmail.mockResolvedValue({ id: "email-1" });
  mocks.generateMonthlyReport.mockResolvedValue("<p>summary</p>");
  mocks.buildMonthlySprint.mockResolvedValue(PLAN);
  mocks.scoreStoredSprint.mockResolvedValue(LAST_MONTH_SCORE);
  mocks.locationCoverageForPeriod.mockResolvedValue({ covered: 1, total: 3, lines: [] });
  mocks.listRescueOutcomes.mockResolvedValue([
    {
      issueId: "i9",
      family: "rescue",
      query: "drain cleaning old town",
      pageUrl: "https://example.com/drain-cleaning/",
      domain: "example.com",
      beforePosition: 14,
      afterPosition: 6,
      deltaPositions: 8,
      resolved: true,
      appliedAt: "2026-08-02T00:00:00.000Z",
      measuredAt: "2026-08-20T00:00:00.000Z",
    },
  ]);
  mocks.getDossierForClient.mockResolvedValue({
    lastVerifiedAt: "2026-08-15T00:00:00.000Z",
    staleWarning: null,
    businessModel: "Family-run plumbing",
    serviceArea: ["Old Town", "Downtown"],
    differentiators: ["24/7 dispatch"],
    audience: "Homeowners",
    recentWins: [],
    gaps: null,
  });
  mocks.reviewVelocityForClient.mockResolvedValue({
    ourHistory: { count: 12 },
    lines: [
      {
        competitor: "Rival Co",
        parity: {
          state: "behind",
          monthsToParity: 7,
          estimate: false,
          ourCount: 12,
          theirCount: 40,
        },
      },
    ],
  });
});

describe("generateReportForCron — the sprint artifact is stored for the period", () => {
  it("stores the built plan as the report row's rawData.sprint", async () => {
    queue("clients", [[{ id: CLIENT, name: "Acme Plumbing", niche: "plumbing", status: "active" }]]);
    queue("blogs", [[{ count: 2 }], [{ avg: 70, scored: 2 }]]);
    queue("seo_issues", [[{ count: 1 }], [{ count: 0 }]]);
    queue("post_verifications", [[{ count: 2 }]]);
    queue("reports", [[{ avg: 65 }]]); // previous-period select; shape-tolerant
    queue("generated_posts", [[{ count: 3 }], [{ total: "12.50" }]]);

    const report = await generateReportForCron(CLIENT, "2026-08-01", "2026-08-31");

    expect(mocks.buildMonthlySprint).toHaveBeenCalledWith(CLIENT);
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0].table).toBe("reports");
    expect(h.inserts[0].values.periodStart).toBe("2026-08-01");
    expect(h.inserts[0].values.periodEnd).toBe("2026-08-31");
    expect((h.inserts[0].values.rawData as { sprint: unknown }).sprint).toBe(PLAN);
    expect((report as { rawData?: { sprint?: unknown } }).rawData?.sprint).toBe(PLAN);
  });
});

describe("emailReportPdfInternal — the §E PDF wiring", () => {
  function seedCommonQueues() {
    queue("reports", [[REPORT_ROW]]);
    queue("clients", [[{ name: "Acme Plumbing", contactEmail: "ops@acme.test" }]]);
  }

  it("carries every §E section and restricts the appendix to SENT packs", async () => {
    seedCommonQueues();
    queue("seo_issues", [
      [{ issueKey: "split:alpha", status: "detected" }, { issueKey: "dead:beta", status: "queued" }],
    ]);
    queue("gbp_assets", [
      [
        {
          assetType: "description",
          payload: { ready: true },
          status: "ready",
          createdAt: new Date("2026-08-10T00:00:00Z"),
          rn: 1,
        },
        {
          assetType: "description",
          payload: { versions: [{ chars: "740" }, { chars: "731" }] },
          status: "sent_to_client",
          createdAt: new Date("2026-08-12T00:00:00Z"),
          rn: 1,
        },
        {
          assetType: "posts",
          payload: { week: 1 },
          status: "sent_to_client",
          createdAt: new Date("2026-08-14T00:00:00Z"),
          rn: 1,
        },
      ],
    ]);

    const result = await emailReportPdfInternal("r1");
    expect(result.success).toBe(true);
    expect(mocks.renderReportPdf).toHaveBeenCalledTimes(1);
    const pdf = capturedPdfData[0] as Record<string, unknown>;

    // 1 — Queries that moved (resolved measurements inside the period only).
    expect(pdf.queriesThatMoved).toEqual([
      expect.objectContaining({ query: "drain cleaning old town", deltaPositions: 8 }),
    ]);
    // 2 — This month's sprint + last month's score.
    expect(pdf.sprintPlan).toBe(PLAN);
    expect(pdf.lastMonthSprintScore).toBe(LAST_MONTH_SCORE);
    // 3 — The dossier first page.
    expect(pdf.dossierSummary).toMatchObject({ businessModel: "Family-run plumbing" });
    // 4 — S3 coverage line.
    expect(pdf.locationCoverage).toMatchObject({ covered: 1, total: 3 });
    // 5 — Parity renewal one-liner (real renderer over mocked velocity data).
    expect(pdf.reviewParityLine).toBe(
      "Review velocity vs Rival Co: about 7 months to parity (ours 12 vs theirs 40).",
    );
    // 6 — Open hygiene counts under the sprint notes.
    expect(pdf.hygieneNote).toContain("1 keyword-split candidate");
    expect(pdf.hygieneNote).toContain("1 zero-traction page");
    // Appendix: the READY description pack must NOT be there — only the sent
    // one (rendered into pack lines) plus the sent posts pack.
    const appendix = pdf.gbpAppendix as {
      sentOn: string | null;
      packs: Array<{ title: string; lines: string[] }>;
    };
    expect(appendix.packs).toHaveLength(2);
    expect(appendix.sentOn).toBe("2026-08-14");
    expect(appendix.packs[0].lines[0]).toBe(
      "2 description versions delivered (740 chars / 731 chars), on a 30-day rotation.",
    );
    // Belt and braces: the ready pack's marker text appears nowhere.
    expect(JSON.stringify(appendix)).not.toContain("READY");
    // Delivered to the client's contact email.
    expect(mocks.sendReportPdfEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ops@acme.test", clientName: "Acme Plumbing" }),
    );
  });

  it("omits the appendix entirely when no pack was ever sent (F8)", async () => {
    seedCommonQueues();
    queue("seo_issues", [[]]);
    queue("gbp_assets", [
      [
        {
          assetType: "description",
          payload: { body: "READY BUT UNSENT" },
          status: "ready",
          createdAt: new Date("2026-08-10T00:00:00Z"),
          rn: 1,
        },
      ],
    ]);

    const result = await emailReportPdfInternal("r1");
    expect(result.success).toBe(true);
    const pdf = capturedPdfData[0] as Record<string, unknown>;
    expect(pdf.gbpAppendix).toBeNull();
  });

  it("omits the hygiene note when the open ledger is all-zero (F8)", async () => {
    seedCommonQueues();
    queue("seo_issues", [[]]);
    queue("gbp_assets", [[]]);

    await emailReportPdfInternal("r1");
    const pdf = capturedPdfData[0] as Record<string, unknown>;
    expect(pdf.hygieneNote).toBeNull();
  });
});