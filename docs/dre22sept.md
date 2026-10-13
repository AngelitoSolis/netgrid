# dre22sept — what is on this branch

Proposal branch. Not merged. Each commit below is independent enough to
revert on its own if it is not wanted. Nothing here changes generation,
publishing, or a cron schedule.

Read `docs/feature-suggestions.md` for why these were picked, and
`docs/uniqueness-definition.md` for the fleet-uniqueness decision that is
**not** built on this branch. That second file is an approval brief. Do not
treat it as a ticket.

| Commit subject | What it adds | What it deliberately does not do |
|---|---|---|
| docs | The two briefs | No code |
| review queue | `/review`. Held = `status=generated` AND `flagged_for_review`. Release calls the existing `publishGeneratedPost`. Dismiss sets `failed` with the existing reject reason. | No new status. No second publisher. Empty unless `SCRUBBER_ENFORCEMENT=enforce`. |
| search console view | `/search`, portal blog card, `GET /api/v1/clients/{id}/search`. Reads `search_performance`. | Does not call Google. Does not coerce a missing window to position 0. |
| pipeline page | `/pipeline`. Last 24h of `cron_runs` and `pipeline_errors`, plus hold count and stale GSC sync. | Does not re-run a job. |
| opportunity inbox | `/opportunities`. Pending `blog_keyword_targets`, highest winnability first. Skip sets the existing `skipped` status, pending rows only, reason required. | Does not reorder the claim query. Does not add a keyword source. |
| site profile + story cap | `0054_site_profiles.sql`. Blog page "Site profile" card. A city-framed target is skipped — and the keyword released — unless the blog has 3 operator facts and a neighborhood or place note. Those facts are the only local sentences the prompt may use. `story_uses` plus `story-reuse.ts` cap one source URL at 5 posts / 30 days and never two on the same query. 13 unit tests. `tsc --noEmit` clean. | Does not fetch local news. Does not invent a neighborhood. Does not rewrite one story 600 ways. A blog with no profile keeps publishing city-free posts. Migration must be applied before the profile card can save. |

Sidebar entries: Review, Search, Opportunities, Pipeline.

Suggested review order: review queue, search view, pipeline page, opportunity
inbox. Drop any commit you do not want; the others do not import each other
except the sidebar, which only links to them.
