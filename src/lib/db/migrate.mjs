// Idempotent migration runner for netgrid.
//
// Why this exists: the project uses hand-written, idempotent SQL migrations
// in ./migrations (the drizzle-kit journal was abandoned — see meta/_journal
// only tracking the first few). Render does not apply migrations on deploy,
// so every schema change previously required someone to run the SQL by hand
// against production. Missed migrations were the recurring cause of runtime
// 500s (a table/column the code expected simply wasn't there yet).
//
// This runner is wired into Render's preDeployCommand (see render.yaml). On
// every deploy it applies any migration files not yet recorded in the
// "_netgrid_migrations" tracking table, in filename order.
//
// REVERT SUPPORT (dev/ops only): `node src/lib/db/migrate.mjs --revert 0057`
// (or `--revert 0057_location_page_targets.sql`) undoes ONE migration by
// running its sibling `<file>.down.sql` and removing its tracking row. The
// runner REFUSES to revert while any later migration is still applied
// (forward-only history is the production contract), errors when the DOWN
// script is absent, and keeps production usage forward-only — the default
// invocation (npm run db:migrate) never looks at .down.sql files.
//
// It is deliberately tolerant of "already in the desired state" errors
// (duplicate table/type/column, missing object on DROP). That makes the very
// first run against an already-populated production database a no-op replay:
// existing objects raise duplicate errors we swallow, genuinely-missing ones
// get created. After that first run every file is recorded and skipped.
//
// Pure Node + @neondatabase/serverless (a runtime dependency) — no tsx, no
// drizzle, so it runs even in a minimal deploy environment.

import { neon } from "@neondatabase/serverless";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

// Files matching this are never auto-applied — sample/dev seed data only.
const SKIP = /seed/i;

/** Sibling DOWN scripts never run in the forward pass. */
const DOWN_SUFFIX = ".down.sql";

/** True when a filename is an UP migration the forward pass should consider.
 * Exported for the revert tests — main() and the tests must agree. */
export function isForwardMigration(file) {
  return file.endsWith(".sql") && !SKIP.test(file) && !file.endsWith(DOWN_SUFFIX);
}

/** `0057_location_page_targets` → `0057_location_page_targets.down.sql`. */
export function downFileName(target) {
  const base = target.endsWith(DOWN_SUFFIX)
    ? target.slice(0, -DOWN_SUFFIX.length)
    : target;
  return base.replace(/\.sql$/i, "") + DOWN_SUFFIX;
}

/**
 * Resolve a `--revert` argument to ONE recorded migration filename. Accepts
 * the exact filename ("0057_location_page_targets.sql"), the name without the
 * extension, or the unique numeric prefix ("0057"). Throws when the argument
 * matches nothing or more than one file, when the migration is not recorded as
 * applied, or when any LATER migration is still applied (forward-only
 * history — revert in reverse order, one at a time).
 */
export function resolveRevertTarget(migrationFiles, applied, arg) {
  const name = String(arg ?? "").trim().replace(/\.sql$/i, "");
  if (!name) {
    throw new Error(
      "[migrate] --revert requires a migration name or number (e.g. --revert 0057)",
    );
  }
  const candidates = migrationFiles.filter(
    (f) => f === `${name}.sql` || f.startsWith(`${name}_`),
  );
  if (candidates.length === 0) {
    throw new Error(`[migrate] no migration matches "${arg}"`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `[migrate] "${arg}" is ambiguous: ${candidates.join(", ")}`,
    );
  }
  const target = candidates[0];
  if (!applied.has(target)) {
    throw new Error(
      `[migrate] ${target} is not recorded as applied — nothing to revert`,
    );
  }
  const later = migrationFiles.filter((f) => f > target && applied.has(f));
  if (later.length > 0) {
    throw new Error(
      `[migrate] refusing to revert ${target} while later migration(s) are still applied: ${later.join(", ")} — revert in reverse order`,
    );
  }
  return target;
}

// Postgres error codes meaning "already in the desired state". Swallowing
// these is what makes a full replay against a live database safe.
const TOLERATED = new Set([
  "42P07", // duplicate_table (also duplicate index / relation)
  "42710", // duplicate_object (type, constraint, ...)
  "42701", // duplicate_column
  "42P06", // duplicate_schema
  "42704", // undefined_object (e.g. DROP TYPE on a type already gone)
  "42703", // undefined_column (e.g. DROP COLUMN already gone)
  "42P01", // undefined_table (e.g. ALTER/DROP on a table already gone)
]);

/**
 * Split a .sql file into individual statements on top-level semicolons,
 * respecting -- line comments, C-style block comments, single-quoted
 * strings, and $tag$ dollar-quoted bodies (used by DO blocks). The neon
 * HTTP driver runs one statement per round-trip, so pre-splitting is
 * required; "--> statement-breakpoint" markers are just line comments and
 * fall out naturally.
 */
export function splitStatements(sql) {
  const out = [];
  let buf = "";
  let line = false;
  let block = false;
  let single = false;
  let dollar = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (line) {
      buf += c;
      if (c === "\n") line = false;
      continue;
    }
    if (block) {
      buf += c;
      if (c === "*" && c2 === "/") {
        buf += c2;
        i++;
        block = false;
      }
      continue;
    }
    if (single) {
      buf += c;
      if (c === "'") {
        if (c2 === "'") {
          buf += c2;
          i++;
        } else {
          single = false;
        }
      }
      continue;
    }
    if (dollar) {
      if (c === "$" && sql.startsWith(dollar, i)) {
        buf += dollar;
        i += dollar.length - 1;
        dollar = null;
      } else {
        buf += c;
      }
      continue;
    }
    if (c === "-" && c2 === "-") {
      line = true;
      buf += c;
      continue;
    }
    if (c === "/" && c2 === "*") {
      block = true;
      buf += c + c2;
      i++;
      continue;
    }
    if (c === "'") {
      single = true;
      buf += c;
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tag) {
        dollar = tag[0];
        buf += tag[0];
        i += tag[0].length - 1;
        continue;
      }
    }
    if (c === ";") {
      if (!isBlank(buf)) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += c;
  }
  if (!isBlank(buf)) out.push(buf.trim());
  return out;
}

/** True when a chunk carries no executable SQL (whitespace / comments only). */
function isBlank(chunk) {
  const stripped = chunk
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
  return stripped.trim().length === 0;
}

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[migrate] DATABASE_URL is not set — cannot run migrations");
    process.exit(1);
  }

  const sql = neon(url);

  await sql.query(
    `CREATE TABLE IF NOT EXISTS "_netgrid_migrations" (
       "name"       text PRIMARY KEY,
       "applied_at" timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const applied = new Set(
    rowsOf(await sql.query(`SELECT "name" FROM "_netgrid_migrations"`)).map(
      (r) => r.name,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(isForwardMigration)
    .sort();

  // ── Revert mode: undo exactly one migration via its sibling .down.sql ──────
  const revertInline = process.argv.find((a) => a.startsWith("--revert="));
  const revertFlag = process.argv.includes("--revert");
  if (revertFlag || revertInline !== undefined) {
    const arg = revertInline
      ? revertInline.slice("--revert=".length)
      : process.argv[process.argv.indexOf("--revert") + 1];
    const target = resolveRevertTarget(files, applied, arg);
    const downFile = downFileName(target);
    const downPath = join(MIGRATIONS_DIR, downFile);
    if (!existsSync(downPath)) {
      console.error(
        `[migrate] ${target} has no ${downFile} — write the DOWN script before reverting`,
      );
      process.exit(1);
    }

    const statements = splitStatements(readFileSync(downPath, "utf8"));
    let skipped = 0;
    for (const stmt of statements) {
      try {
        await sql.query(stmt);
      } catch (err) {
        const code = err && (err.code || (err.sourceError && err.sourceError.code));
        // "Already gone" is the desired end state of a DOWN script, so the
        // same tolerance set as the forward pass keeps reverts idempotent.
        if (code && TOLERATED.has(code)) {
          skipped++;
          continue;
        }
        console.error(`[migrate] ${downFile} — statement failed:\n${stmt}\n`);
        throw err;
      }
    }

    await sql.query(`DELETE FROM "_netgrid_migrations" WHERE "name" = $1`, [
      target,
    ]);
    console.log(
      `[migrate] reverted ${target} via ${downFile}` +
        (skipped ? ` (${skipped} already-absent statement(s) skipped)` : ""),
    );
    return;
  }

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const statements = splitStatements(
      readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
    );

    let skipped = 0;
    for (const stmt of statements) {
      try {
        await sql.query(stmt);
      } catch (err) {
        const code = err && (err.code || (err.sourceError && err.sourceError.code));
        if (code && TOLERATED.has(code)) {
          skipped++;
          continue;
        }
        console.error(`[migrate] ${file} — statement failed:\n${stmt}\n`);
        throw err;
      }
    }

    await sql.query(
      `INSERT INTO "_netgrid_migrations" ("name") VALUES ($1) ON CONFLICT DO NOTHING`,
      [file],
    );
    appliedCount++;
    console.log(
      `[migrate] applied ${file}` +
        (skipped ? ` (${skipped} already-present statement(s) skipped)` : ""),
    );
  }

  console.log(
    appliedCount === 0
      ? "[migrate] up to date — no new migrations"
      : `[migrate] done — ${appliedCount} migration file(s) applied`,
  );
}

// Only run when invoked directly (node migrate.mjs), not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[migrate] fatal:", err);
    process.exit(1);
  });
}
