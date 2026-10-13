// Route-level tests for the v1 client-search cursor modes (§I.4 conventions,
// provable without a database): the ?hygiene=1 mode added in R5 shares the
// exact parseSince / limit-clamp / strict-> nextCursor conventions of the
// shipped ?rescues=1 mode — both are pinned here against mocked services.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiAuthGuard: vi.fn(),
  listRescueOutcomes: vi.fn(),
  listLocationPageOutcomes: vi.fn(),
  listHygieneIssues: vi.fn(),
  searchSummaryForClient: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({ apiAuthGuard: mocks.apiAuthGuard }));
vi.mock("@/lib/services/page2-rescue", () => ({
  listRescueOutcomes: mocks.listRescueOutcomes,
}));
vi.mock("@/lib/services/location-matrix", () => ({
  listLocationPageOutcomes: mocks.listLocationPageOutcomes,
}));
vi.mock("@/lib/services/query-hygiene", () => ({
  listHygieneIssues: mocks.listHygieneIssues,
}));
vi.mock("@/lib/search/performance-summary", () => ({
  searchSummaryForClient: mocks.searchSummaryForClient,
}));
// LA-today is the only thing the route needs from gsc-sync; the real module
// pulls the whole GSC stack.
vi.mock("@/lib/services/gsc-sync", () => ({ gscToday: () => "2026-09-25" }));

import { GET } from "./[clientId]/search/route";

const CLIENT = "11111111-1111-4111-8111-111111111111";

function get(path: string): Request {
  return new Request(`http://localhost/api/v1/clients/${CLIENT}/search${path}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.apiAuthGuard.mockResolvedValue(null);
});

describe("v1 client search — ?hygiene=1 cursor mode (R5b)", () => {
  it("returns hygiene rows with nextCursor from the LAST detectedAt (full page)", async () => {
    const t1 = "2026-09-02T10:00:00.000Z";
    const t2 = "2026-09-03T10:00:00.000Z";
    mocks.listHygieneIssues.mockResolvedValueOnce([
      { issueId: "i1", family: "split", status: "detected", detectedAt: t1, decidedAt: null },
      { issueId: "i2", family: "dead", status: "approved", detectedAt: t2, decidedAt: t2 },
    ]);
    const res = await GET(get("?hygiene=1&limit=2&since=2026-09-01T00:00:00Z"), {
      params: { clientId: CLIENT },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("hygiene");
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBe(t2);
    // ?since passed through as the strict-> cursor bound.
    expect(mocks.listHygieneIssues).toHaveBeenCalledWith(CLIENT, {
      since: new Date("2026-09-01T00:00:00Z"),
      limit: 2,
    });
  });

  it("a partial page terminates the cursor (nextCursor null)", async () => {
    mocks.listHygieneIssues.mockResolvedValueOnce([
      { issueId: "i1", family: "pin", status: "detected", detectedAt: "2026-09-02T10:00:00.000Z" },
    ]);
    const res = await GET(get("?hygiene=1&limit=50"), { params: { clientId: CLIENT } });
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
  });

  it("no ?since defaults to the start of the LA-current month (gscToday)", async () => {
    mocks.listHygieneIssues.mockResolvedValueOnce([]);
    await GET(get("?hygiene=1"), { params: { clientId: CLIENT } });
    expect(mocks.listHygieneIssues).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ since: new Date("2026-09-01T00:00:00Z") }),
    );
  });

  it("clamps limit to 1..500 — same band as every cursor mode", async () => {
    mocks.listHygieneIssues.mockResolvedValue([]);
    await GET(get("?hygiene=1&limit=9999"), { params: { clientId: CLIENT } });
    expect(mocks.listHygieneIssues).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ limit: 500 }),
    );
    await GET(get("?hygiene=1&limit=0"), { params: { clientId: CLIENT } });
    expect(mocks.listHygieneIssues).toHaveBeenLastCalledWith(
      CLIENT,
      expect.objectContaining({ limit: 1 }),
    );
  });
});

describe("v1 client search — auth + the shared conventions (§I.4)", () => {
  it("an unauthenticated caller gets the guard's denial, verbatim", async () => {
    const denial = { status: 401 };
    mocks.apiAuthGuard.mockResolvedValueOnce(denial);
    const res = await GET(get("?hygiene=1"), { params: { clientId: CLIENT } });
    expect(res).toBe(denial);
    expect(mocks.listHygieneIssues).not.toHaveBeenCalled();
  });

  it("a non-uuid clientId is a 400 before any data read", async () => {
    const res = await GET(get("?hygiene=1"), { params: { clientId: "not-a-uuid" } });
    expect(res.status).toBe(400);
  });

  it("?rescues=1 keeps its measuredAt cursor convention (parity guard)", async () => {
    const m = "2026-09-04T10:00:00.000Z";
    mocks.listRescueOutcomes.mockResolvedValueOnce([
      { issueId: "r1", family: "rescue", measuredAt: m },
    ]);
    const res = await GET(get("?rescues=1&limit=1"), { params: { clientId: CLIENT } });
    const body = await res.json();
    expect(body.mode).toBe("rescues");
    expect(body.nextCursor).toBe(m);
  });
});