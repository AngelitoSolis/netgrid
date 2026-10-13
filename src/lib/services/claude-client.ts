import Anthropic from "@anthropic-ai/sdk";
import { getFixModel, isDeepSeekFixModel } from "@/lib/settings/app-settings";
import { recordPipelineError } from "@/lib/services/run-telemetry";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const DEEPSEEK_BASE_URL =
  process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";

// Operator-selected model for SEO fixes + reports (Settings → AI Models).
// Defaults to CLAUDE_MODEL env / Sonnet 4.6. Resolved per call (cheap — cached
// in app-settings) so a Settings change takes effect without a redeploy. Falls
// back to the default on any lookup error.
async function fixModel(): Promise<string> {
  try {
    return await getFixModel();
  } catch (err) {
    recordPipelineError({
      site: "claude-client.fixModel",
      code: "FIX_MODEL_LOOKUP_FAILED",
      severity: "error",
      message: `Fix-model lookup failed, using the env default: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  }
}

/**
 * Provider-aware text call for the fix/report path. Routes to DeepSeek (its
 * OpenAI-compatible endpoint) or Claude based on the fix-model setting, so
 * operators can steer these calls off Anthropic (e.g. when Claude credit is
 * exhausted). Returns the model's raw text output.
 */
async function callFixModel(opts: {
  system?: string;
  user: string;
  maxTokens: number;
  json?: boolean;
}): Promise<string> {
  const model = await fixModel();

  if (isDeepSeekFixModel(model)) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "SEO fix model is set to DeepSeek, but DEEPSEEK_API_KEY is not configured.",
      );
    }
    const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          ...(opts.system
            ? [{ role: "system", content: opts.system }]
            : []),
          { role: "user", content: opts.user },
        ],
        max_tokens: opts.maxTokens,
        temperature: 0.7,
        thinking: { type: "disabled" },
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`DeepSeek ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    // An empty string is NOT a valid fix. seo-autofix trims whatever comes
    // back and pushes it straight to the live site as the meta title or
    // description, so a silent empty response blanks a real tag. We do not
    // change control flow here (that is T25's job) — but the operator must
    // be able to see it happening.
    if (!text.trim()) {
      recordPipelineError({
        site: "claude-client.callFixModel",
        code: "FIX_MODEL_EMPTY",
        severity: "error",
        message: "DeepSeek fix-model call returned empty content",
        context: { model, maxTokens: opts.maxTokens, json: Boolean(opts.json) },
      });
    }
    return text;
  }

  const message = await anthropic.messages.create({
    model,
    max_tokens: opts.maxTokens,
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: "user", content: opts.user }],
  });
  const textBlock = message.content.find((b) => b.type === "text");
  const text = textBlock?.text || "";
  if (!text.trim()) {
    recordPipelineError({
      site: "claude-client.callFixModel",
      code: "FIX_MODEL_EMPTY",
      severity: "error",
      message: `Anthropic fix-model call returned no text block (stop_reason=${
        message.stop_reason ?? "unknown"
      })`,
      context: { model, maxTokens: opts.maxTokens, json: Boolean(opts.json) },
    });
  }
  return text;
}

export async function generateSeoFix(params: {
  niche: string;
  blogDomain: string;
  pageUrl: string;
  pageTitle: string;
  pageContentExcerpt: string;
  issueType: string;
  issueDescription: string;
}): Promise<string> {
  return await callFixModel({
    maxTokens: 1024,
    system: `You are an SEO specialist generating fixes for a blog in the ${params.niche} niche.
The blog is: ${params.blogDomain}.
Generate content that is:
- Relevant to the blog's niche and existing content
- SEO-optimized with natural keyword usage
- Unique (not duplicating any existing meta descriptions on the site)
- Within character limits (meta descriptions: 150-160 chars, titles: 50-60 chars)
- Professional and engaging for the target audience
Current page title: ${params.pageTitle}
Current page URL: ${params.pageUrl}
Page content excerpt: ${params.pageContentExcerpt}`,
    user: `Fix this SEO issue: ${params.issueType}
Description: ${params.issueDescription}
Return ONLY the fix content, nothing else. No explanations, no labels.`,
  });
}

/**
 * S1 page-2 rescue — meta title + description rewrite for ONE existing page
 * that already ranks on page two for a real query (the article's highest-ROI
 * tactic: "you're already there, just better"). Runs at DETECTION time so the
 * apply step is deterministic with ZERO LLM calls. The S6 dossier context block
 * is injected verbatim as the facts source — everything must trace to it or to
 * the page itself; gaps stay gaps (F3). On any failure the caller stores a
 * null proposal and apply falls back to generateSeoFix's path.
 */
export async function generateRescueMeta(params: {
  query: string;
  avgPosition: number;
  impressions90d: number;
  currentTitle: string | null;
  currentDescription: string | null;
  pageExcerpt: string;
  niche: string;
  /** The S6 dossier context block (buildDossierContextBlock) — the ONE facts source. */
  dossierContext: string;
}): Promise<{ title: string; description: string }> {
  const text = await callFixModel({
    maxTokens: 1024,
    json: true,
    user: `You are rewriting the meta title + description of ONE existing page that already ranks #${Math.round(
      params.avgPosition,
    )} for "${params.query}" (${params.impressions90d} impressions in 90 days). We are on page two. The goal is a top-5 finish WITHOUT changing what the page is about.

CLIENT DOSSIER (facts source — use only these):
${params.dossierContext}

CURRENT TITLE (${(params.currentTitle ?? "").length} chars): ${params.currentTitle || "(none)"}
CURRENT DESCRIPTION: ${params.currentDescription || "(none)"}
PAGE CONTENT EXCERPT: ${params.pageExcerpt}

RULES: title ≤ 58 chars, the query or a natural variant in the first half, one differentiator from the dossier facts above (never invented); description ≤ 148 chars, states who/where/benefit and ends with a soft CTA matching the business's real service area; no keyword stuffing, no em-dash spam.
Output JSON: {"title": "...", "description": "..."}`,
  });

  try {
    const parsed = JSON.parse(text || "{}") as { title?: unknown; description?: unknown };
    return {
      title: typeof parsed.title === "string" ? parsed.title.trim().slice(0, 120) : "",
      description:
        typeof parsed.description === "string"
          ? parsed.description.trim().slice(0, 300)
          : "",
    };
  } catch (err) {
    recordPipelineError({
      site: "claude-client.generateRescueMeta",
      code: "RESCUE_META_PARSE_FAILED",
      severity: "warn",
      message: `Rescue-meta JSON did not parse — opening the issue with a null proposal so apply falls back to generateSeoFix: ${
        err instanceof Error ? err.message : String(err)
      }`,
      context: { query: params.query, rawLength: text.length },
    });
    return { title: "", description: "" };
  }
}

export async function generateMonthlyReport(params: {
  clientName: string;
  clientNiche: string;
  periodStart: string;
  periodEnd: string;
  totalBlogs: number;
  /** Null when no site in the account has a measured quality score yet. */
  avgScore: number | null;
  /** Null on a first report, or when the previous report had no measurement. */
  prevAvgScore: number | null;
  trendDirection: string;
  totalPosts: number;
  onSchedule: number;
  issuesFixed: number;
  criticalRemaining: number;
  topBlogDomain?: string;
  topBlogScoreChange?: number;
  concernBlogDomain?: string;
  concernReason?: string;
}): Promise<string> {
  return await callFixModel({
    maxTokens: 2048,
    system: `You are a professional SEO analyst writing a monthly performance report for a client
who invested in a private blog network to dominate the ${params.clientNiche} niche.
Write in a confident, professional tone. The client is NOT technical — avoid jargon.
Focus on outcomes and trajectory, not technical details.
Use positive framing where possible, but be honest about areas needing improvement.
If a figure is given as "not yet measured", say plainly that it is not yet measured
and explain that measurement is being established. NEVER invent a number, estimate
one, or imply a score exists when the data says it does not.
Structure the report as:
1. Executive Summary (2-3 sentences: overall health, direction, key number)
2. Highlights (top 3 wins this month)
3. Network Health (overall score, trend, comparison to last month)
4. Content Activity (posts published, schedule adherence)
5. Areas of Focus (what we're working on next month)
Keep the entire report under 500 words. Use simple HTML formatting (h3, p, ul, strong).`,
    user: `Generate the monthly report for ${params.clientName}.
Period: ${params.periodStart} to ${params.periodEnd}
Data:
- Total blogs: ${params.totalBlogs}
- Average quality score: ${params.avgScore ?? "not yet measured"} (last month: ${params.prevAvgScore ?? "not yet measured"})
- Trend: ${params.trendDirection}
- Total posts published: ${params.totalPosts}
- Blogs on schedule: ${params.onSchedule} / ${params.totalBlogs}
- Issues fixed this month: ${params.issuesFixed}
- Critical issues remaining: ${params.criticalRemaining}
${params.topBlogDomain ? `- Top improving blog: ${params.topBlogDomain} (+${params.topBlogScoreChange} points)` : ""}
${params.concernBlogDomain ? `- Most concerning blog: ${params.concernBlogDomain} (${params.concernReason})` : ""}`,
  });
}

export async function generateIssueDescription(params: {
  issueType: string;
  pageUrl: string;
  technicalDetails: string;
}): Promise<{ title: string; description: string; suggestedFix: string }> {
  const text = await callFixModel({
    maxTokens: 512,
    json: true,
    user: `Generate a concise SEO issue report in JSON format for:
Issue type: ${params.issueType}
Page URL: ${params.pageUrl}
Technical details: ${params.technicalDetails}

Return ONLY valid JSON with keys: title (short, under 100 chars), description (1-2 sentences explaining why this matters), suggestedFix (1-2 sentences explaining the fix).`,
  });

  try {
    return JSON.parse(text || "{}");
  } catch (err) {
    recordPipelineError({
      site: "claude-client.issueDescription",
      code: "ISSUE_DESC_PARSE_FAILED",
      severity: "warn",
      message: `Issue-description JSON did not parse, using the stub: ${
        err instanceof Error ? err.message : String(err)
      }`,
      context: { issueType: params.issueType, rawLength: text.length },
    });
    return {
      title: params.issueType,
      description: params.technicalDetails,
      suggestedFix: "Manual review required.",
    };
  }
}
