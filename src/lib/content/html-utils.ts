import * as cheerio from "cheerio";

/**
 * Shared HTML surgery for the content pipeline (T23).
 *
 * Everything in here operates on a real parse tree rather than on the HTML
 * source string. The rule this module exists to enforce: a regex may only
 * touch HTML when the thing it is matching cannot nest, cannot be quoted and
 * cannot be split across attributes. Word counting, tag stripping, unwrapping
 * and text rewriting satisfy none of those, which is why they all live here.
 *
 * It has no imports beyond cheerio, so it is unit-testable without the DB, the
 * Anthropic SDK or Next.js.
 */

/**
 * Structural view of a parsed node. We deliberately do NOT import types from
 * `domhandler`: it is a transitive dependency of cheerio, not one we declare
 * in package.json, and importing it directly would break the build the day
 * cheerio reshuffles its tree. `type`, `name`, `data` and `children` are all
 * we touch, and writing `data` mutates the object cheerio serializes.
 */
export interface DomNode {
  type: string;
  name?: string;
  data?: string;
  children?: DomNode[];
}

export interface TextNodeContext {
  /** True when this text node is the first child of its parent. */
  isFirstInParent: boolean;
  /** Lowercased parent tag name; "" at the fragment root. */
  parentName: string;
}

/** Text inside these is never rewritten by a typography pass. */
const VERBATIM_TAGS = new Set(["code", "pre", "script", "style"]);

/**
 * Parse an article body as a FRAGMENT. The third argument is `isDocument`;
 * with `false`, parse5 invents no <html>/<head>/<body> wrappers and $.html()
 * round-trips the body it was given.
 */
export function loadFragment(html: string): cheerio.CheerioAPI {
  return cheerio.load(html, null, false);
}

/** The fragment's root node, typed for the walkers below. */
export function rootNode($: cheerio.CheerioAPI): DomNode {
  return $.root()[0] as unknown as DomNode;
}

function appendText(node: DomNode, out: string[]): void {
  if (node.type === "text") {
    out.push(node.data ?? "");
    return;
  }
  if (node.type === "comment" || node.type === "directive") return;
  const name = node.name ? node.name.toLowerCase() : "";
  if (name === "script" || name === "style") return;
  // A space on EVERY element boundary. This reproduces exactly what the old
  // `html.replace(/<[^>]*>/g, " ")` did — so word counts across the network do
  // not shift when we move to a parser — but it can no longer be fooled by a
  // ">" inside an attribute value, and it never counts a tag as a word.
  out.push(" ");
  for (const child of node.children ?? []) appendText(child, out);
  out.push(" ");
}

/** Visible text of a node — or of the whole fragment, for a root node. */
export function nodeText(node: DomNode): string {
  const out: string[] = [];
  if (node.type === "root") {
    for (const child of node.children ?? []) appendText(child, out);
  } else {
    appendText(node, out);
  }
  return out.join("").replace(/\s+/g, " ").trim();
}

/** Visible text of an HTML fragment. Entities are decoded by the parser. */
export function htmlToPlainText(html: string): string {
  return nodeText(rootNode(loadFragment(html)));
}

/** Word count of already-extracted plain text. */
export function countTextWords(text: string): number {
  return text ? text.split(" ").filter((w) => w.length > 0).length : 0;
}

/** THE word count for article bodies. Every caller must use this one. */
export function countHtmlWords(html: string): number {
  return countTextWords(htmlToPlainText(html));
}

/** Word count of a single already-parsed element. */
export function elementWords(node: DomNode): number {
  return countTextWords(nodeText(node));
}

/** Depth-first walk over every rewritable text node. */
export function forEachTextNode(
  node: DomNode,
  fn: (textNode: DomNode, ctx: TextNodeContext) => void,
): void {
  const children = node.children ?? [];
  const parentName = node.name ? node.name.toLowerCase() : "";
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "text") {
      fn(child, { isFirstInParent: i === 0, parentName });
      continue;
    }
    if (child.type === "comment" || child.type === "directive") continue;
    const name = child.name ? child.name.toLowerCase() : "";
    if (VERBATIM_TAGS.has(name)) continue;
    forEachTextNode(child, fn);
  }
}

/** A word that ends a sentence, optionally followed by a closing quote. */
const SENTENCE_END = /[.!?:;]["')\]]?$/;

/**
 * Remove at least `n` trailing words from `node`, then keep removing until
 * what remains ends on a sentence boundary (or the node is empty). Mutates the
 * tree in place and returns how many words were actually removed — which may
 * exceed `n` because of the sentence alignment.
 */
export function trimTrailingWords(node: DomNode, n: number): number {
  if (n <= 0) return 0;
  const texts: DomNode[] = [];
  forEachTextNode(node, (t) => texts.push(t));
  let removed = 0;
  for (let i = texts.length - 1; i >= 0; i--) {
    const parts = (texts[i].data ?? "").split(/(\s+)/);
    while (parts.length > 0) {
      const last = parts[parts.length - 1];
      if (!last.trim()) {
        parts.pop();
        continue;
      }
      if (removed >= n && SENTENCE_END.test(last)) {
        texts[i].data = parts.join("");
        return removed;
      }
      parts.pop();
      removed++;
    }
    texts[i].data = "";
  }
  return removed;
}

/** Elements that carry no meaning once trimming has emptied them. */
const PRUNABLE =
  "p, li, ul, ol, dl, dt, dd, h1, h2, h3, h4, h5, h6, blockquote, strong, em, a, code";

/**
 * Drop elements that trimming emptied out. Runs to a fixed point so an <li>
 * emptied on pass 1 lets its now-childless <ul> go on pass 2.
 */
export function pruneEmptyElements($: cheerio.CheerioAPI): void {
  for (let pass = 0; pass < 6; pass++) {
    const empties = $(PRUNABLE).filter(
      (_, el) => $(el).children().length === 0 && $(el).text().trim() === "",
    );
    if (empties.length === 0) return;
    empties.remove();
  }
}

/**
 * Soft word-count enforcement.
 *
 * Counts REAL words (tags excluded, so a link-rich article is no longer
 * treated as over-length), then brings the body under `max` by shaving the
 * TAIL of the middle sections — never the opening paragraph and never the
 * conclusion — and finally re-serializes through the parser so no block can
 * be left unclosed. We still never pad shorts; that is the prompt's job.
 *
 * The first block is protected because it feeds the excerpt, the meta
 * description and injectMoneyLink. The last block is protected because it is
 * the article's ending; amputating it is what the old implementation did.
 */
export function capWordCount(html: string, max: number): string {
  const total = countHtmlWords(html);
  if (total <= max) return html; // byte-identical when nothing to do
  const $ = loadFragment(html);
  const blocks = $.root().children().toArray();
  let excess = total - max;
  if (blocks.length === 0) {
    // Bare text, no block structure — trim the fragment itself.
    trimTrailingWords(rootNode($), excess);
    return $.html();
  }
  if (blocks.length === 1) {
    trimTrailingWords(blocks[0] as unknown as DomNode, excess);
    pruneEmptyElements($);
    return $.html();
  }
  for (let i = blocks.length - 2; i >= 1 && excess > 0; i--) {
    const node = blocks[i] as unknown as DomNode;
    excess -= trimTrailingWords(node, excess);
    if (elementWords(node) === 0) $(blocks[i]).remove();
  }
  // Opening + conclusion alone still bust the cap — shave the opening too.
  if (excess > 0) {
    const first = blocks[0] as unknown as DomNode;
    excess -= trimTrailingWords(first, excess);
    if (elementWords(first) === 0) $(blocks[0]).remove();
  }
  pruneEmptyElements($);
  return $.html();
}