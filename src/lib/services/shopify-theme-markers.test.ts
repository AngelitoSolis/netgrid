import { describe, it, expect } from "vitest";
import { buildSeoMetaBlock } from "./shopify-theme-client";
import { schemaMarkerToken } from "@/lib/seo/structured-data";

const token = schemaMarkerToken("example.myshopify.com");

describe("Shopify theme SEO block markers", () => {
  it("prints no vendor name into the storefront", () => {
    // The old fences read "BEGIN netgrid-seo v3 — managed by netgrid", which
    // put the vendor name in the <head> of every storefront in the network
    // and made the whole estate enumerable with one search operator.
    const block = buildSeoMetaBlock({ markerToken: token });
    expect(block).not.toMatch(/netgrid/i);
  });

  it("is stable per store and differs across stores", () => {
    const a = buildSeoMetaBlock({ markerToken: token });
    const b = buildSeoMetaBlock({ markerToken: token });
    const c = buildSeoMetaBlock({
      markerToken: schemaMarkerToken("other.myshopify.com"),
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("fences the block so an upgrade can find and replace it", () => {
    const block = buildSeoMetaBlock({ markerToken: token });
    expect(block).toContain(`${token} v`);
    expect(block).toContain(`/${token} v`);
  });

  it("never emits the vendor name even with no token supplied", () => {
    expect(buildSeoMetaBlock()).not.toMatch(/netgrid/i);
  });

  it("bakes in a resolved author node when one is supplied", () => {
    const block = buildSeoMetaBlock({
      markerToken: token,
      authorNode: { "@type": "Person", name: "Jane Doe", "@id": "https://x/#p" },
    });
    expect(block).toContain('"name":"Jane Doe"');
    // The Liquid fallback is replaced, not appended beside it.
    expect(block).not.toContain("article.author | default: shop.name");
  });

  it("keeps the Liquid fallback when no author is known", () => {
    const block = buildSeoMetaBlock({ markerToken: token });
    expect(block).toContain("article.author | default: shop.name");
  });
});
