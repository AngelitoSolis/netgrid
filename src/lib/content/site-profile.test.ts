import { describe, expect, it } from "vitest";
import { gateLocalProfile, parseFactText, renderProfileDirective } from "./site-profile";

const three = [
  "Serves a 4-course Piedmont menu, no pizza.",
  "Terrace seats 18 and closes when the city terrace permit says so.",
  "Reservations only through their own site, no delivery.",
];

describe("gateLocalProfile", () => {
  it("refuses a missing profile", () => {
    const g = gateLocalProfile(null);
    expect(g.ok).toBe(false);
  });

  it("refuses two facts even with a neighborhood", () => {
    const g = gateLocalProfile({
      neighborhood: "Plateau",
      signatureFacts: three.slice(0, 2),
    });
    expect(g.ok).toBe(false);
  });

  it("refuses three facts with no place grain", () => {
    const g = gateLocalProfile({ signatureFacts: three, neighborhood: "  " });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/neighborhood/i);
  });

  it("accepts three facts plus a neighborhood and does not invent a fourth", () => {
    const g = gateLocalProfile({
      neighborhood: "Plateau",
      signatureFacts: [...three, "ok", "Serves a 4-course Piedmont menu, no pizza."],
    });
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.profile.signatureFacts).toHaveLength(3);
      expect(g.profile.neighborhood).toBe("Plateau");
    }
  });

  it("parses a textarea into facts and drops short lines", () => {
    expect(parseFactText("short\n\nTerrace seats 18 and is permit-limited.\n")).toEqual([
      "Terrace seats 18 and is permit-limited.",
    ]);
  });

  it("renders only the supplied facts", () => {
    const g = gateLocalProfile({ neighborhood: "Mile End", signatureFacts: three, doesNot: ["No brunch, ever, including Sundays."] });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const text = renderProfileDirective(g.profile);
    expect(text).toContain("Piedmont");
    expect(text).toContain("Mile End");
    expect(text).toContain("Do not add a street");
    expect(text).not.toContain("Montreal");
  });
});
