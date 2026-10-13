/**
 * A story may enter the fleet once. It may not leave 600 times.
 *
 * The cap is deliberate and small. Five posts in 30 days, never two on the
 * same normalised query. Rewriting the same readout for Montreal and then
 * for Laval is the same article — the query check is what stops that, not
 * the voice.
 *
 * This module does not fetch news and does not call a model. Callers hand
 * it the uses they already stored. The decision is pure so it can be tested
 * without a database.
 */

import { createHash } from "node:crypto";

export const STORY_REUSE_CAP = 5;
export const STORY_REUSE_WINDOW_DAYS = 30;

export interface StoryUse {
  storyKey: string;
  queryNorm: string;
  createdAt: Date;
}

export type StoryDecision =
  | { allow: true; storyKey: string }
  | { allow: false; storyKey: string; reason: string };

export function storyKeyFor(sourceUrl: string): string {
  return createHash("sha256").update(sourceUrl.trim().toLowerCase()).digest("hex").slice(0, 32);
}

export function normalizeStoryQuery(query: string): string {
  return query
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function decideStoryReuse(
  sourceUrl: string,
  query: string,
  priorUses: StoryUse[],
  now = new Date(),
  cap = STORY_REUSE_CAP,
  windowDays = STORY_REUSE_WINDOW_DAYS,
): StoryDecision {
  const storyKey = storyKeyFor(sourceUrl);
  const queryNorm = normalizeStoryQuery(query);
  if (!queryNorm) {
    return { allow: false, storyKey, reason: "No query — a story with nothing to change is not attached." };
  }
  const cutoff = now.getTime() - windowDays * 864e5;
  const recent = priorUses.filter(
    (u) => u.storyKey === storyKey && u.createdAt.getTime() >= cutoff,
  );
  if (recent.some((u) => u.queryNorm === queryNorm)) {
    return {
      allow: false,
      storyKey,
      reason: `This story was already used for "${queryNorm}". A second city does not make it a second article.`,
    };
  }
  if (recent.length >= cap) {
    return {
      allow: false,
      storyKey,
      reason: `This story already powered ${recent.length} posts in ${windowDays} days (cap ${cap}). It is not rewritten onto another site.`,
    };
  }
  return { allow: true, storyKey };
}
