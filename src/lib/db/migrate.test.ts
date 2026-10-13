// Tests for the migration runner's PURE surface (src/lib/db/migrate.mjs).
// The DB-touching paths (apply / revert against a live Postgres) need a real
// DATABASE_URL — their transcripts live in docs/seo-loop-status.md. Everything
// that can fail WITHOUT a database (forward-file selection, --revert argument
// resolution, the statement splitter the revert path shares) is pinned here.
import { describe, expect, it } from "vitest";
import {
  downFileName,
  isForwardMigration,
  resolveRevertTarget,
  splitStatements,
} from "./migrate.mjs";

describe("isForwardMigration — the forward pass never sees DOWN scripts", () => {
  it("accepts normal UP migrations", () => {
    expect(isForwardMigration("0056_issue_key_and_rescue.sql")).toBe(true);
  });

  it("excludes sibling DOWN scripts", () => {
    expect(isForwardMigration("0056_issue_key_and_rescue.down.sql")).toBe(false);
  });

  it("excludes seed files (the SKIP pattern)", () => {
    expect(isForwardMigration("seed_001_sample.sql")).toBe(false);
    expect(isForwardMigration("0060_dev_seed.sql")).toBe(false);
  });
});

describe("downFileName", () => {
  it("maps an UP filename to its sibling DOWN script", () => {
    expect(downFileName("0058_gbp_packs.sql")).toBe("0058_gbp_packs.down.sql");
  });

  it("passes an already-DOWN name through unchanged", () => {
    expect(downFileName("0058_gbp_packs.down.sql")).toBe(
      "0058_gbp_packs.down.sql",
    );
  });
});

describe("resolveRevertTarget — §I.2's one-at-a-time revert contract", () => {
  const files = [
    "0056_issue_key_and_rescue.sql",
    "0057_location_page_targets.sql",
    "0058_gbp_packs.sql",
    "0059_client_seo_dossiers.sql",
  ];

  it("accepts the exact filename", () => {
    const applied = new Set(["0057_location_page_targets.sql"]);
    expect(resolveRevertTarget(files, applied, "0057_location_page_targets.sql")).toBe(
      "0057_location_page_targets.sql",
    );
  });

  it("accepts the unique numeric prefix", () => {
    const applied = new Set(["0059_client_seo_dossiers.sql"]);
    expect(resolveRevertTarget(files, applied, "0059")).toBe(
      "0059_client_seo_dossiers.sql",
    );
  });

  it("accepts the name without the extension", () => {
    const applied = new Set(["0058_gbp_packs.sql"]);
    expect(resolveRevertTarget(files, applied, "0058_gbp_packs")).toBe(
      "0058_gbp_packs.sql",
    );
  });

  it("throws when nothing matches", () => {
    expect(() => resolveRevertTarget(files, new Set(), "0099")).toThrow(
      /no migration matches/,
    );
  });

  it("throws when the prefix is ambiguous", () => {
    const many = ["0100_a.sql", "0100_b.sql"];
    expect(() =>
      resolveRevertTarget(many, new Set(many), "0100"),
    ).toThrow(/ambiguous/);
  });

  it("throws when the target is not recorded as applied", () => {
    expect(() =>
      resolveRevertTarget(files, new Set(["0057_location_page_targets.sql"]), "0058"),
    ).toThrow(/not recorded as applied/);
  });

  it("REFUSES while a later migration is still applied (forward-only history)", () => {
    const applied = new Set([
      "0056_issue_key_and_rescue.sql",
      "0057_location_page_targets.sql",
      "0058_gbp_packs.sql",
    ]);
    expect(() => resolveRevertTarget(files, applied, "0056")).toThrow(
      /refusing to revert 0056_issue_key_and_rescue\.sql.*0057_location_page_targets\.sql.*0058_gbp_packs\.sql/,
    );
  });

  it("allows reverting the latest applied migration", () => {
    const applied = new Set([
      "0057_location_page_targets.sql",
      "0058_gbp_packs.sql",
    ]);
    expect(resolveRevertTarget(files, applied, "0058")).toBe("0058_gbp_packs.sql");
  });

  it("throws on an empty argument", () => {
    expect(() => resolveRevertTarget(files, new Set(), "")).toThrow(
      /--revert requires/,
    );
    expect(() => resolveRevertTarget(files, new Set(), undefined)).toThrow(
      /--revert requires/,
    );
  });
});

describe("splitStatements — the splitter the revert path shares with apply", () => {
  it("splits on top-level semicolons and drops blanks", () => {
    expect(
      splitStatements("DROP INDEX IF EXISTS a;\n\nDROP TABLE IF EXISTS b;"),
    ).toEqual(["DROP INDEX IF EXISTS a", "DROP TABLE IF EXISTS b"]);
  });

  it("keeps semicolons inside single-quoted strings", () => {
    expect(
      splitStatements(`UPDATE t SET note = 'a;b' WHERE id = 1;`),
    ).toEqual([`UPDATE t SET note = 'a;b' WHERE id = 1`]);
  });

  it("keeps semicolons inside dollar-quoted DO blocks", () => {
    const sql = [
      "DO $$",
      "BEGIN",
      "  RAISE NOTICE 'hi';",
      "END",
      "$$;",
    ].join("\n");
    expect(splitStatements(sql)).toHaveLength(1);
  });

  it("ignores -- comments and returns [] for comment-only input", () => {
    expect(splitStatements("-- just a note\n-- another\n")).toEqual([]);
  });
});