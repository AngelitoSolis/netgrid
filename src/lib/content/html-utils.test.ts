import { describe, it, expect } from "vitest";
import {
  capWordCount,
  countHtmlWords,
  forEachTextNode,
  htmlToPlainText,
  loadFragment,
  pruneEmptyElements,
  rootNode,
  trimTrailingWords,
} from "./html-utils";

/**
 * The counter is the spine of this task: capWordCount enforces against it, the
 * scrubber's Layer 1F band check reports against it, and generateContent's hard
 * floor throws against it. Three separate implementations disagreed before —
 * one counted markup as words, so a link-rich article was trimmed below the
 * band by its own generator.
 */
function article(realWords: number, anchors: number): string {
  const parts: string[] = [];
  let used = 0;
  let a = 0;
  while (used < realWords) {
    const chunk: string[] = [];
    for (let k = 0; k < 40 && used < realWords; k++, used++) chunk.push(`word${used}`);
    let text = chunk.join(" ");
    if (a < anchors) {
      text = text.replace(
        `word${used - 20}`,
        `<a href="https://example.com/s/${a}" target="_blank" rel="noopener nofollow">word${used - 20}</a>`,
      );
      a++;
    }
    parts.push(`<p>${text}</p>`);
  }
  return parts.join("\n");
}

describe("countHtmlWords", () => {
  it("does not count tags or attributes as words", () => {
    const html =
      '<a href="https://example.com/study/1" target="_blank" rel="noopener nofollow">word</a>';
    expect(countHtmlWords(html)).toBe(1);
  });

  it("is not fooled by a '>' inside an attribute value", () => {
    expect(countHtmlWords('<p title="a > b">one two</p>')).toBe(2);
  });

  it("decodes entities", () => {
    expect(htmlToPlainText("<p>salt &amp; pepper</p>")).toBe("salt & pepper");
  });

  it("separates block text instead of welding it", () => {
    // cheerio's $.root().text() (post-seo-scanner) would produce "end.Next".
    expect(countHtmlWords("<p>end.</p><p>Next.</p>")).toBe(2);
  });
});

describe("loadFragment", () => {
  it("invents no document skeleton around a body", () => {
    const $ = loadFragment("<p>one</p>");
    expect($.html()).toBe("<p>one</p>");
    expect(rootNode($).type).toBe("root");
  });

  it("keeps non-ASCII text as UTF-8 (this network publishes French)", () => {
    const $ = loadFragment("<p>Étude — détaillée</p>");
    expect($.html()).toContain("Étude");
  });
});

describe("capWordCount", () => {
  it("leaves a link-rich body under the cap byte-identical", () => {
    const html = article(1900, 40);
    expect(countHtmlWords(html)).toBe(1900);
    expect(capWordCount(html, 2000)).toBe(html);
  });

  it("never leaves a block unclosed when it has to cut", () => {
    const html =
      "<p>one two three</p>\n<h2>Heading here</h2>\n<ul>\n<li>alpha beta.</li>\n" +
      "<li>gamma delta.</li>\n</ul>\n<p>The closing thought.</p>";
    const out = capWordCount(html, 8);
    const open = (out.match(/<(ul|li|h2|p)[\s>]/g) ?? []).length;
    const close = (out.match(/<\/(ul|li|h2|p)>/g) ?? []).length;
    expect(open).toBe(close);
    expect(countHtmlWords(out)).toBeLessThanOrEqual(8);
  });

  it("keeps the opening block and the conclusion", () => {
    const html =
      "<p>Opening sentence here.</p><p>Middle one.</p><p>Middle two.</p>" +
      "<p>The closing thought.</p>";
    const out = capWordCount(html, 7);
    expect(out).toContain("Opening sentence here.");
    expect(out).toContain("The closing thought.");
  });

  it("is byte-identical when the body is inside the cap", () => {
    const html = "<p>one two three four five</p>";
    expect(capWordCount(html, 5)).toBe(html);
  });
});

describe("trimTrailingWords", () => {
  it("stops at the first sentence boundary at or after n", () => {
    const $ = loadFragment("<p>First one. Second one. Third one. Fourth one.</p>");
    // Two words takes it to "Fourth one." — already a sentence, so it stops.
    const removed = trimTrailingWords(rootNode($), 2);
    expect(removed).toBe(2);
    expect($.html()).toBe("<p>First one. Second one. Third one.</p>");
  });

  it("removes more than n when the cut would land mid-sentence", () => {
    const $ = loadFragment("<p>First one. Second one. Third one. Fourth one.</p>");
    // Three words lands inside "Fourth one.", so it keeps going back to the
    // end of the previous sentence rather than publishing a fragment.
    const removed = trimTrailingWords(rootNode($), 3);
    expect(removed).toBe(4);
    expect($.html()).toBe("<p>First one. Second one.</p>");
  });

  it("empties the node when there is no sentence boundary to stop at", () => {
    const $ = loadFragment("<p>alpha beta gamma</p>");
    expect(trimTrailingWords(rootNode($), 1)).toBe(3);
    expect($.html()).toBe("<p></p>");
  });
});

describe("pruneEmptyElements", () => {
  it("removes emptied list scaffolding to a fixed point", () => {
    const $ = loadFragment("<ul><li></li></ul><p>kept</p>");
    pruneEmptyElements($);
    expect($.html()).toBe("<p>kept</p>");
  });

  it("leaves a node that still has children alone", () => {
    const $ = loadFragment("<p><strong>x</strong></p>");
    pruneEmptyElements($);
    expect($.html()).toBe("<p><strong>x</strong></p>");
  });
});

describe("forEachTextNode", () => {
  it("skips <code>, <pre>, <script>, <style> and comments", () => {
    const seen: string[] = [];
    const $ = loadFragment(
      "<p>a</p><code>c</code><pre>p</pre><script>s</script><!-- note --><p>b</p>",
    );
    forEachTextNode(rootNode($), (node, ctx) => {
      seen.push(`${ctx.parentName}:${node.data}`);
    });
    expect(seen).toEqual(["p:a", "p:b"]);
  });

  it("reports whether the text node is first in its parent", () => {
    const flags: boolean[] = [];
    const $ = loadFragment("<p><em>first</em> and <em>second</em></p>");
    forEachTextNode(rootNode($), (node, ctx) => flags.push(ctx.isFirstInParent));
    expect(flags).toEqual([true, false, true]);
  });
});