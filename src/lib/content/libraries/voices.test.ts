import { describe, it, expect } from "vitest";
import { VOICES, VOICE_IDS } from "./voices";

/**
 * Credential words that must never appear in a persona string.
 *
 * A persona is interpolated VERBATIM into the system prompt as
 * "You are {voice.persona}." (skeletons.ts), so a credential here is not
 * flavour text — it is an instruction to impersonate a licensed professional
 * on a YMYL page, published under a byline with no such person behind it.
 *
 * Matched on word boundaries: "clinician" must fail, but "refers out to a
 * clinician" is a referral, not a claim, so the assertion below tests the
 * claim shape rather than the bare noun where the two differ.
 */
const CREDENTIAL_CLAIMS = [
  "physician",
  "pharmacist",
  "licensed",
  "board-certified",
  "practising physician",
  "practicing physician",
  "registered nurse",
  "medical doctor",
  "phd",
  "m\\.d\\.",
  "attorney",
  "solicitor",
  "certified public accountant",
  "registered dietitian",
];

/** Phrases that claim the writer HOLDS a qualification or role. */
const CLAIM_PATTERNS = [
  /\bis an? (?:practising |practicing |licensed |certified |registered )?(?:physician|pharmacist|nurse|doctor|attorney|lawyer|dietitian|surgeon)\b/i,
  /\b(?:trained|qualified) (?:as|in) (?:medicine|pharmacy|law|nursing)\b/i,
  /\bwith (?:a )?(?:medical|pharmacy|nursing|law) (?:degree|licence|license)\b/i,
  /\bformer (?:physician|pharmacist|clinician|nurse|surgeon)\b/i,
];

describe("voice personas assert no professional credential", () => {
  it("has all 127 voices", () => {
    expect(VOICE_IDS).toHaveLength(127);
  });

  for (const word of CREDENTIAL_CLAIMS) {
    it(`no persona contains "${word.replace(/\\/g, "")}"`, () => {
      const re = new RegExp(`(?:^|[^a-z])${word}(?:[^a-z]|$)`, "i");
      const offenders = VOICE_IDS.filter((id) => re.test(VOICES[id].persona)).map(
        (id) => `V${id}: ${VOICES[id].persona}`,
      );
      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }

  it("no persona claims to hold a qualification or clinical role", () => {
    const offenders: string[] = [];
    for (const id of VOICE_IDS) {
      for (const re of CLAIM_PATTERNS) {
        if (re.test(VOICES[id].persona)) {
          offenders.push(`V${id}: ${VOICES[id].persona}`);
          break;
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("every persona is still a non-empty descriptive string", () => {
    // The fix must not have hollowed a persona out — reading behaviour and
    // temperament are what carry the voice once the credential is gone.
    for (const id of VOICE_IDS) {
      const p = VOICES[id].persona;
      expect(p.trim().length, `V${id} persona is too short`).toBeGreaterThan(30);
    }
  });

  it("keeps the register signature, which is what actually carries the voice", () => {
    for (const id of VOICE_IDS) {
      expect(VOICES[id].registerSignature.trim().length).toBeGreaterThan(10);
    }
  });
});
