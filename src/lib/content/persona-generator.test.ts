import { describe, it, expect } from "vitest";
import { credentialClaimIn } from "./persona-generator";
import type { GeneratedPersona } from "@/lib/content/types";

function persona(over: Partial<GeneratedPersona> = {}): GeneratedPersona {
  return {
    persona: "a writer who reads the methods section before the abstract and says so",
    registerSignature: "Short sentences; dry; names what the study did not measure",
    examplePara1: "The trial ran for eight weeks. That is long enough to see a change in the marker they chose, and not long enough to see whether it lasts.",
    examplePara2: "Most of the confident claims here trace back to one small study.",
    ...over,
  };
}

describe("credentialClaimIn", () => {
  it("passes a credential-free persona", () => {
    expect(credentialClaimIn(persona())).toBeNull();
  });

  // The persona is interpolated verbatim as "You are {voice.persona}." and
  // overrides the library voice permanently once stored, so a credential here
  // is a fabricated-expertise claim on a YMYL page — not a flourish.
  const offenders: Array<[field: keyof GeneratedPersona, value: string]> = [
    ["persona", "a practising physician who writes about peptides"],
    ["persona", "a licensed pharmacist with 10 years at the bench"],
    ["persona", "a PhD in molecular biology who left academia"],
    ["persona", "a board-certified endocrinologist"],
    ["registerSignature", "Writes like the registered dietitian she is"],
    ["examplePara1", "As a nurse, I have seen this go wrong."],
    ["examplePara2", "Our attorney reviewed this."],
    ["toneNotes", "Lean on her CPA background."],
    ["label", "Board certified skeptic"],
  ];

  for (const [field, value] of offenders) {
    it(`rejects a credential in ${field}: ${value.slice(0, 40)}`, () => {
      expect(credentialClaimIn(persona({ [field]: value }))).not.toBeNull();
    });
  }

  it("scans every persisted field, not just the persona", () => {
    // A credential smuggled into an example paragraph is published prose.
    expect(credentialClaimIn(persona({ examplePara2: "I trained in pharmacy." }))).not.toBeNull();
  });

  it("is case-insensitive", () => {
    expect(credentialClaimIn(persona({ persona: "A PHYSICIAN who writes" }))).not.toBeNull();
  });

  it("matches on word boundaries, not substrings", () => {
    // "mds" inside an ordinary word must not trip the MD alternative, or the
    // filter becomes unusable and gets softened — which is the real risk.
    expect(credentialClaimIn(persona({ persona: "a writer covering commodities and markets daily" }))).toBeNull();
  });
});
