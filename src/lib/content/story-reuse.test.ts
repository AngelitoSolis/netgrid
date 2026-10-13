import { describe, expect, it } from "vitest";
import { decideStoryReuse, storyKeyFor, type StoryUse } from "./story-reuse";

const url = "https://example.com/glp1-trial";
const now = new Date("2026-09-22T12:00:00Z");

function use(query: string, daysAgo: number): StoryUse {
  return {
    storyKey: storyKeyFor(url),
    queryNorm: query,
    createdAt: new Date(now.getTime() - daysAgo * 864e5),
  };
}

describe("decideStoryReuse", () => {
  it("allows the first use", () => {
    expect(decideStoryReuse(url, "BPC-157 sourcing", [], now).allow).toBe(true);
  });

  it("refuses the same query even for another city", () => {
    const d = decideStoryReuse(url, "buy peptides", [use("buy peptides", 2)], now);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/already used/);
  });

  it("treats accent and case variants as the same query", () => {
    const d = decideStoryReuse(url, "Café Montréal", [use("cafe montreal", 1)], now);
    expect(d.allow).toBe(false);
  });

  it("allows a genuinely different query under the cap", () => {
    const d = decideStoryReuse(url, "BPC-157 COA", [use("buy peptides", 1)], now);
    expect(d.allow).toBe(true);
  });

  it("stops at five uses in the window", () => {
    const prior = [0, 1, 2, 3, 4].map((i) => use(`query ${i}`, 3));
    const d = decideStoryReuse(url, "query 9", prior, now);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/cap 5/);
  });

  it("ignores uses older than 30 days", () => {
    const prior = [0, 1, 2, 3, 4].map((i) => use(`query ${i}`, 40));
    expect(decideStoryReuse(url, "query 9", prior, now).allow).toBe(true);
  });

  it("does not let a different story's uses count against this one", () => {
    const other: StoryUse = { ...use("buy peptides", 1), storyKey: "deadbeef" };
    expect(decideStoryReuse(url, "buy peptides", [other], now).allow).toBe(true);
  });
});
