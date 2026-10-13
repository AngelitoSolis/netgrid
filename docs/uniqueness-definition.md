# What "properly unique" means — approval brief

Status: **for approval. Not a build spec.** Written against `main` at `f6bfca5`.

This answers one question before any feed or prompt work starts: when 300
restaurants sit in the same city, or 600 peptide sites could all react to the
same headline, what is allowed to be shared, and what must never be shared.

## 1. The decision, stated so it can be approved or rejected

**Properly does not mean "Google cannot tell these were made by the same tool."**
That goal is a disguise. Google does not need to detect the vendor. It
compares pages. If 300 pages answer the same query with the same sections and
the city name swapped, they are the same page. A different voice, a different
skeleton, and a weekly headline pasted into each one does not change that.

**Properly means each URL is the best page for one query that only that
business can answer, and it refuses to publish when it cannot be.**

Approve this sentence, or rewrite it, before anything below is built. If the
goal stays "reuse one news piece across 600 sites so they do not look the
same," stop. That is the pattern the tool was just rebuilt to prevent.

The local-content plan already says this in `docs/local-keyword-content-plan.md`
§8: this shape is exactly what scaled-content and doorway guidance targets, and
the honest mitigation is pacing plus genuine per-page difference, not more
templates. T09 then made city framing illegal unless the client has a real
`local_presence` and the keyword is transactional. A city on a blog means
"this site is aimed there," not "this business is there."

## 2. What the tool already does, and why it is not enough

Already in the product, and not a feature request:

| Layer | What it differentiates | What it does not |
|---|---|---|
| Style profile | Locked voice, skeleton, word band, quirks, persona per blog | Facts. Two sites can be stylistically distant and factually identical. |
| Author entity | A real byline with a page, or the publish is refused (YMYL) | A local witness. The author is a writer, not the restaurant. |
| Keyword ledger | One target per intent cluster, not one post per Autocomplete variant | A reason this business should rank for it. |
| City framing | Only if `local_presence` and the query is transactional | Neighborhood, hours, menu, landmark, competitor set. |
| News | One pool per **vertical**, refreshed weekly, 6 headlines pasted into ideation, then marked used | Per-city news. Per-business news. A rule that the same story cannot ship on 600 sites. |
| Duplication score | Cosine similarity against sibling posts. 0.80 clean, 0.92 flags, 0.95 scores 0. **Not yet calibrated on the live corpus.** | A pre-publish block. It scores after the fact. |

News today is the opposite of the restaurant case. `takeNewsContextForVertical`
pulls unused items for the vertical and marks them used, so the next blog in
that vertical is nudged not to reuse the headline. It does not know Montreal
from Brossard, and it does not know restaurant A from restaurant B. Peptide
## 3. The five layers that are allowed to differ

Uniqueness is a stack. A page is not unique because one layer moved.

| Layer | Shared across the fleet? | Rule |
|---|---|---|
| **1. Business facts** | Never shared. One profile per client site. | The only layer that makes two same-city restaurants different. If this layer is thin, do not publish a local page. |
| **2. Place facts** | Shared by neighborhood, not by city, and not by business. | "Montreal" is not a differentiator when 300 clients are in Montreal. The block, the metro, the market, the campus are. |
| **3. Query** | Shared only when the query is actually different. | "best pasta Montreal" on 40 sites is one query, forty doorways. Each site gets the queries it can win, not the city's head terms. |
| **4. Time** | A fact with a date and a source, used by few sites, and only when it changes the answer. | A headline is not a layer. "The terrace bylaw changed on 12 May and this restaurant's patio seats 40" is. |
| **5. Expression** | Must differ, but counts as zero uniqueness by itself. | Voice, skeleton, word band, language. Already built. Do not invest more here until 1–4 are real. |

**Approve this test.** Before a post is allowed to publish, it must contain at
least three checkable facts from layer 1 that do not appear in any sibling
post for the same query in the same city, plus one checkable fact from layer
2 or 4 that is dated and sourced. If it cannot, the cron skips that site
today. Skipping is the feature. Publishing a substitute is the failure.

## 4. What "reuse one news piece across 600 sites" is allowed to mean

A story may enter the system once. It may not leave the system 600 times.

Allowed:

- Store the story once, with source, date, and geography (industry / country / city / neighborhood).
- Attach it only to sites whose profile makes the story change the answer.
  A GLP-1 trial readout can inform a peptide site that sells that compound.
  It cannot inform a peptide site that does not stock it, and it cannot
  inform a restaurant at all.
- Cap reuse. Proposed cap, to approve or change: **one story powers at most
  5 posts in a 30-day window, and never two posts on the same query.**
  Five is a starting number, not a law. The duplication score, once
  calibrated, is what moves it.
- Each of those posts must answer a different question. "What the trial
  means for a clinic that already offers X" and "what the trial means for a
  retailer that only sells Y" are different articles. "What the trial means
  for Montreal" and "what the trial means for Laval" are the same article.

Not allowed:

- Rewriting the same story in a different voice per site.
- Inventing a local angle the feed did not supply ("diners in the Plateau
  are talking about…"). T12 already banned fabricated anecdotes. A local
  news feature that asks the model to imagine the neighborhood puts that
  ban back.
- Using a story older than its usefulness window. Industry regulatory news:
  14 days. Local event news: 72 hours. Evergreen place facts are not news
  and do not expire weekly.
- Marking a story "used" vertically, which is what the code does now. Used
  must be per (story, site) and per (story, query). Otherwise the first blog
## 5. The profile, because the feed is useless without it

A feed cannot differentiate a site the tool does not know. Today a client row
has a niche, a custom prompt, CTA, language, and a boolean `local_presence`.
A blog row has an optional city, region, country, brand. That cannot tell
two Plateau restaurants apart, and it cannot tell two peptide retailers apart
beyond the city string.

### 5a. Business profile — required before local publishing

Collected once, by the operator or the client, not invented by the model.
Empty fields stay empty. The prompt may not fill them.

For a restaurant, the minimum that makes a page non-interchangeable:

- Legal name, public brand, and the name locals actually use
- Full address, neighborhood, nearest transit / landmark (operator-confirmed)
- What it actually serves (cuisine, 8–15 signature dishes, price band)
- What it does not do (no brunch, no delivery, no groups over 6)
- Hours, reservation method, terrace / takeout / dietary reality
- Who cooks or owns, in their own words, with permission to publish
- Three real differentiators a competitor two streets away does not share
- Languages served, and the language the dining room actually runs in

For a peptide / retail site, the equivalent minimum:

- What is actually sold (SKUs, not the niche label)
- Who it is for, and who it refuses
- Fulfilment reality (pickup neighborhood, ship-to provinces, not a fake city)
- The sourcing / COA story that is true for this store
- A named author who is allowed to write about it (already a publish gate)

**Approve this rule:** a local page cannot be generated until the profile has
the minimum fields for its vertical. A site with only a city and a niche
stays on the non-local path, which already exists and is the correct fallback.

### 5b. Place profile — shared, small, and not a business

One row per neighborhood, not per restaurant. Built from free sources and
confirmed once. Contains only stable facts: boundaries in plain language,
## 6. Feeds worth adding, cheapest first

Only feeds that produce a checkable fact. A feed that produces "vibes" is
rejected even if it is free.

| Feed | Cost | Serves | Use | Do not use for |
|---|---|---|---|---|
| **Operator / client profile** (form, not a feed) | $0 | Layer 1 | The whole strategy. Nothing else works without it. | — |
| **Google News RSS** (already built) | $0 | Layer 4, industry | One stored story, capped reuse, attached only when a profile field makes it relevant. | Local color. RSS will not know the restaurant. |
| **OpenStreetMap / Overpass** | $0 | Layer 2 | Neighborhood, nearest metro, parks, markets. Confirmed by the operator, then cached forever. | "Popular dishes". OSM does not know the menu. Do not bulk-geocode 1,000 sites against the public Nominatim API; geocode once, cache, or self-host. |
| **Transit GTFS** (STM, RTL, EXO, and the US equivalents are open) | $0 | Layer 2 | "4 minutes from Sherbrooke station" when that is true of the address. | A weekly article. Transit does not change weekly. |
| **Environment Canada / NWS** | $0 | Layer 4, narrow | Terrace and weather-dependent businesses, and only when the forecast changes the answer this week. | Every vertical. A peptide site has no weather article. |
| **Municipal open data + council RSS** | $0 | Layer 4, local | Terrace permits, construction on the block, market calendars, festival street closures. This is the legitimate "what is happening in that area." | A city-wide story pasted onto every restaurant in the city. Attach at neighborhood grain. |
| **Client's own site** (menu page, hours, the Google Business Profile the client already owns) | $0 | Layer 1 | Refresh the profile when the menu changes. The client's site is the source of truth for the client's facts. | Scraping competitors to invent comparison claims. |
| **Wikidata** | $0 | Layer 2, sparse | A notable landmark or institution near the address, if the item exists. | Most storefronts. They are not in Wikidata. Do not pretend they are. |
| **PubMed / ClinicalTrials.gov** | $0 | Layer 4, peptides only | The data-pipeline hint the peptide vertical already names and does not fetch. Store the trial, attach only to sites that sell the compound. | Restaurants. Also not a licence to write medical advice. The YMYL author gate still applies. |
| **Search Console** (already stored) | $0 | What to write next | The query this URL is actually being shown for. Stronger than any news feed. | A uniqueness costume. |
| **A local-events API** | Free tier, then paid | Layer 4 | Only if municipal open data does not already cover that city's calendar. | Standing up 600 "things to do this weekend" blogs. That is a doorway network of its own. |

Explicitly not approved, even though they are cheap:

- A second LLM pass whose job is "make this sound local." That manufactures the layer-1 facts the profile was supposed to supply.
- Review-text scraping. ToS problems, and it trains the model to invent quotes. If a client wants a review cited, they paste the sentence and the URL, and the page quotes it.
- Paid rank trackers, Ahrefs, Semrush. Not the uniqueness problem.
- Any feed that is city-level only. At 300 businesses per city, city-level is the same as no feed.

## 8. What we are not building in this decision

- More voices, more skeletons, more temperature. Expression is already the strongest layer and the least useful one.
- A restaurant vertical that is a peptide vertical with the word restaurant swapped in. The registry has no restaurant entry because the facts are different, not because the label is missing.
- Automatic publishing of local pages for any site that only has a city string. That path should stay closed, which is what `local_presence` already does for city framing.
- A guarantee that Google will not classify the network. No feed provides that. The controllable outcome is: each URL says something a sibling URL cannot say, and the ones that cannot are not published.

## 9. Decisions needed from you

Answer these and the build can be scoped. Until then this file is the spec of the problem, not permission to start.

1. **The sentence in §1.** Is the goal "the page only this business could have," or is the goal still "reuse one asset across the fleet invisibly"? Only the first is buildable without recreating the doorway problem.
2. **The reuse cap.** 5 posts per story per 30 days, never two on the same query. Change the number if you want. Do not remove the cap.
3. **The skip rule.** A site with a thin profile does not get a local page that day. Confirm you would rather publish fewer posts than similar ones.
4. **Profile minimum.** Confirm the restaurant field list and the peptide field list in §5a, or cut them. Adding fields is fine. Making them optional is not — optional fields become empty, and empty fields become invented ones.
5. **Grain.** Neighborhood, not city. Confirm, because every feed in §6 is pointless at city grain once a city has hundreds of clients.
6. **First vertical to prove it.** Recommend one city, one vertical, 15 sites, profiles filled by hand, four weeks, no new paid API. Restaurants and peptides should not share a first build. They fail differently.
7. **Feeds in v1.** Recommend only: the profile form, Google News RSS you already have (with the new attach rule), OSM for neighborhood, and municipal open data for the one city in the pilot. Weather and transit wait until a page has actually needed them.

Nothing in `docs/feature-suggestions.md` should start from this file until §9 is answered. The review queue and the search tab still stand on their own and do not depend on this decision.

## 7. How a week should actually run, once this is approved

This is the operating picture to approve, not a ticket.

1. Monday: refresh industry news once per vertical (already scheduled) and neighborhood news once per neighborhood that has at least one active client. Not once per site.
2. The attach step, not the model, decides which sites may use which story. A site with no matching profile field gets no story. It publishes from its own profile, or it skips.
3. Generation receives a packet: business facts (required), one place fact, zero or one story, the target query, and the expression profile it already has. The prompt is told which sentences must stay literally true and may not be embellished.
4. A similarity check against the other posts that used the same story, and against the other sites in the same neighborhood on the same query, runs **before** publish. Over the flag threshold, hold.
5. The page cites the story it used, with the source URL and the date, in the visible body. A "local angle" that cannot link to a source is not shipped.

If step 2 attaches the same story to more than the cap, that is a bug in the attach step, not a prompt problem.

transit, market day, campus, known seasonal pattern. It is context the
business profile hangs off. It is never the subject of the article unless the
query is about the place.

300 restaurants in one city should resolve to something like 40–80
neighborhoods, not 1 city and not 300 invented "areas."

  to generate eats the only timely fact and the other 599 get nothing — or,
  if you stop marking used, all 600 get the same paragraph.

**Approve the cap and the attach rule before a feed is added.** Without them,
every new source makes the fleet more alike, not less.

news is industry-global (`geographyScope: "global"`). There is no restaurant
vertical in the registry at all (peptides, gyms, Quebec roofing, tax, pest,
charity).

So "add local news to the prompt" on top of this would make 300 Montreal
restaurants share one weather story and one industry story, written in 300
voices. That is a template with a date on it.
