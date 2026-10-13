import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildSeoQualityDirective } from "./seo-quality";
import { CADENCES } from "./libraries/cadences";
import { pickWordBand } from "./assignment/algorithm";
import type { CadenceId } from "./types";

const CADENCE_IDS = Object.keys(CADENCES).map(Number) as CadenceId[];

/** Pull the "~N words" numbers out of the rendered rhythm rule. */
function rhythmNumbers(text: string): { avg: number; split: number } {
  const avg = text.match(/average (?:around )?~(\d+) words/i)
    ?? text.match(/at or below ~(\d+) words/i);
  const split = text.match(/runs past ~(\d+) words/i);
  expect(avg, `no average in: ${text.slice(0, 200)}`).toBeTruthy();
  expect(split, `no split in: ${text.slice(0, 200)}`).toBeTruthy();
  return { avg: Number(avg![1]), split: Number(split![1]) };
}

describe("on-page quality block vs the cadence it is appended to", () => {
  // The whole defect: this block is concatenated AFTER the composer's cadence
  // spec, so a fixed "~20 word average / split past ~28" rule arriving last
  // overrode the cadence on every post — collapsing a planned per-blog
  // uniqueness axis into uniform sub-20-word prose network-wide.
  it("never contradicts a cadence's own average", () => {
    const offenders: string[] = [];
    for (const id of CADENCE_IDS) {
      const c = CADENCES[id];
      const { avg } = rhythmNumbers(buildSeoQualityDirective(c));
      if (avg !== c.numbers.avgWords) {
        offenders.push(`cadence ${id} (${c.name}): rule says ${avg}, cadence says ${c.numbers.avgWords}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("never forbids a cadence's own long-sentence exemplar", () => {
    const offenders: string[] = [];
    for (const id of CADENCE_IDS) {
      const c = CADENCES[id];
      const { split } = rhythmNumbers(buildSeoQualityDirective(c));
      if (split < c.numbers.longExample) {
        offenders.push(
          `cadence ${id} (${c.name}): split ${split} < longExample ${c.numbers.longExample}`,
        );
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps a hard readability ceiling regardless of cadence", () => {
    for (const id of CADENCE_IDS) {
      expect(rhythmNumbers(buildSeoQualityDirective(CADENCES[id])).split).toBeLessThanOrEqual(50);
    }
  });

  it("is not a blanket relaxation — a short cadence gets a TIGHTER rule", () => {
    // Cadence 3 "Punchy short-form" (avg 12, long 22) derives 26, tighter than
    // the old fixed 28. If this ever loosens, the derivation has drifted into
    // "always allow more", which is not what it is for.
    const punchy = CADENCE_IDS.find((id) => CADENCES[id].numbers.avgWords <= 12);
    expect(punchy, "no short cadence in the table").toBeTruthy();
    const { split } = rhythmNumbers(buildSeoQualityDirective(CADENCES[punchy!]));
    expect(split).toBeLessThan(28);
  });

  it("tells the model the cadence wins, not just a different number", () => {
    // Recency wins in practice, so the last word on rhythm has to defer
    // explicitly rather than merely restate a value.
    const text = buildSeoQualityDirective(CADENCES[1]);
    expect(text).toMatch(/cadence stated earlier in this prompt, and that cadence wins/i);
  });

  it("reproduces the previous wording when there is no cadence", () => {
    const text = buildSeoQualityDirective(null);
    expect(text).toContain("Keep the AVERAGE sentence length at or below ~20 words");
    expect(text).toContain("runs past ~28 words");
  });

  it("keeps every other on-page rule on all paths", () => {
    for (const c of [null, CADENCES[1]]) {
      const text = buildSeoQualityDirective(c);
      // T05's blocks must survive the refactor — this module replaced a
      // constant that carried all four.
      expect(text).toContain("ANSWER-FIRST STRUCTURE");
      expect(text).toContain("INFORMATION GAIN");
      expect(text).toContain("FACTS POLICY");
      expect(text).toContain("ON-PAGE QUALITY");
      expect(text).toContain("UNIQUE text");
      expect(text).toContain("UNIQUE, descriptive anchor text");
    }
  });
});

describe("per-blog word band", () => {
  it("stays inside the network envelope and keeps a fixed width", () => {
    // Every band is 400 wide and inside [1000, 2000], which is what makes this
    // change independent of token budgets, the generator's word cap and
    // scrubber Layer 1F.
    for (let i = 0; i < 200; i++) {
      const pool = [1 + (i % 24), 2 + (i % 20), 5 + (i % 15)] as never[];
      const cadence = ((i % 24) + 1) as never;
      const [min, max] = pickWordBand(`blog-${i}`, cadence, pool);
      expect(max - min).toBe(400);
      expect(min).toBeGreaterThanOrEqual(1000);
      expect(max).toBeLessThanOrEqual(2000);
    }
  });

  it("is deterministic for a given seed", () => {
    const pool = [1, 2, 5] as never[];
    expect(pickWordBand("seed-a", 1 as never, pool)).toEqual(
      pickWordBand("seed-a", 1 as never, pool),
    );
  });

  it("actually varies across the network", () => {
    // The defect: every one of ~1,500 profiles carried an identical band, so
    // the prompt asked every site for the same length — a cross-site signal
    // cheaper to compute than any prose statistic.
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const pool = [1 + (i % 24), 7 + (i % 12), 13 + (i % 10)] as never[];
      seen.add(pickWordBand(`blog-${i}`, (((i % 24) + 1) as never), pool).join("-"));
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it("leans longer for a long-sentence cadence than a short one", () => {
    const pool = [1, 2, 3, 4, 5] as never[];
    const longCadence = CADENCE_IDS.find((id) => CADENCES[id].numbers.avgWords >= 21)!;
    const shortCadence = CADENCE_IDS.find((id) => CADENCES[id].numbers.avgWords <= 15)!;
    const [longMin] = pickWordBand("same-seed", longCadence, pool);
    const [shortMin] = pickWordBand("same-seed", shortCadence, pool);
    expect(longMin).toBeGreaterThanOrEqual(shortMin);
  });
});

describe("custom-prompt path keeps its promised guardrails", () => {
  it("ships the AI vocabulary blocklist its docblock promises", async () => {
    // The docblock promised "the anti-AI-tell punctuation/word rules" always
    // apply. The body delivered only the punctuation half — so every blog with
    // a custom prompt was free to write "delve into the tapestry of", the most
    // recognisable machine-writing signature, while the scrubber still tested
    // for those exact words and flagged the post.
    const { BLOCK_AI_TELLS_VOCAB, BLOCK_AI_TELLS_PUNCTUATION, BLOCK_AI_TELLS } =
      await import("./libraries/ai-tells");

    expect(BLOCK_AI_TELLS_VOCAB).toContain("delve");
    expect(BLOCK_AI_TELLS_VOCAB).toContain("tapestry");
    // The split must be lossless — BLOCK_AI_TELLS is what all 12 skeletons use.
    expect(BLOCK_AI_TELLS).toContain(BLOCK_AI_TELLS_VOCAB);
    expect(BLOCK_AI_TELLS).toContain(BLOCK_AI_TELLS_PUNCTUATION);
    // And the halves must not overlap, or the custom path would state the
    // punctuation rules twice.
    expect(BLOCK_AI_TELLS_VOCAB).not.toContain("PUNCTUATION:");
    expect(BLOCK_AI_TELLS_PUNCTUATION).not.toContain("delve");
  });
});

describe("quirk 21 no longer asks for banned punctuation", () => {
  it("does not instruct the model to use em-dashes", async () => {
    // It spent a blog's ONE highly-visible quirk slot on a character
    // BLOCK_AI_TELLS bans in all 12 skeletons and Layer 1C strips
    // unconditionally — a tic that could never survive to the page.
    const { QUIRKS } = await import("./libraries/quirks");
    expect(QUIRKS[21].promptInstruction).not.toMatch(/em-dash|—/);
    // The slot must survive: removing the key throws in quirksByCategory,
    // which runs on every blog assignment.
    expect(QUIRKS[21].category).toBe("highly_visible");
    expect(QUIRKS[21].promptInstruction.length).toBeGreaterThan(40);
  });

  it("keeps ten highly-visible quirks so the assignment maths is unchanged", async () => {
    const { quirksByCategory } = await import("./libraries/quirks");
    expect(quirksByCategory("highly_visible")).toHaveLength(10);
  });
});

describe("French directive resolves the punctuation conflict", () => {
  it("permits guillemets and bans exactly what Layer 1C strips", () => {
    // "French punctuation conventions" was the whole instruction, and it was
    // partly unsatisfiable: guillemets are fine, but the tiret cadratin and
    // the ellipsis character are banned upstream and stripped by Layer 1C.
    const src = readFileSync("src/lib/services/content-generator.ts", "utf8");
    const start = src.indexOf("LANGUE / LANGUAGE");
    const block = src.slice(start, start + 1400);
    expect(block).toContain("guillemets");
    expect(block).toMatch(/tiret cadratin/);
    expect(block).toMatch(/Do NOT use curly quotes/);
    expect(block).not.toMatch(/French punctuation conventions\./);
  });
});
