import { describe, it, expect } from "vitest";
import { normalizeShardOpts, shardForId, shardForBlog } from "./sharding";

describe("shardForId", () => {
  it("is the same partition function as shardForBlog", () => {
    // The DataForSEO cron shards by CLIENT id and the auto-publish/keyword
    // crons shard by BLOG id. If these two ever diverge, the crons partition
    // the network differently and the "same shard covers the same slice"
    // assumption in render.yaml quietly stops holding.
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "8f2a1c3e-0000-4000-8000-00000000abcd",
      "ffffffff-ffff-4fff-bfff-ffffffffffff",
    ];
    for (const id of ids) {
      for (const n of [1, 2, 4, 8]) {
        expect(shardForId(id, n)).toBe(shardForBlog(id, n));
      }
    }
  });

  it("returns a value inside the shard range", () => {
    for (let i = 0; i < 64; i++) {
      const s = shardForId(`id-${i}`, 4);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(4);
    }
  });
});

describe("normalizeShardOpts", () => {
  it("defaults to the single unsharded partition", () => {
    expect(normalizeShardOpts({})).toEqual({ shardIndex: 0, shardCount: 1 });
  });

  it("keeps a valid pair", () => {
    expect(normalizeShardOpts({ shardIndex: 3, shardCount: 4 })).toEqual({
      shardIndex: 3,
      shardCount: 4,
    });
  });

  it("wraps an index past the count instead of emptying the queue", () => {
    // An out-of-range index must not silently select nothing — that would
    // look exactly like "this shard had no work".
    expect(normalizeShardOpts({ shardIndex: 5, shardCount: 4 }).shardIndex).toBe(1);
  });

  it("falls back to one shard on junk input", () => {
    for (const bad of [0, -1, NaN, undefined]) {
      expect(normalizeShardOpts({ shardCount: bad as number }).shardCount).toBe(1);
    }
    expect(normalizeShardOpts({ shardIndex: -2, shardCount: 4 }).shardIndex).toBe(0);
  });

  it("floors fractional values rather than producing a fractional shard", () => {
    expect(normalizeShardOpts({ shardIndex: 2.9, shardCount: 4.7 })).toEqual({
      shardIndex: 2,
      shardCount: 4,
    });
  });
});
