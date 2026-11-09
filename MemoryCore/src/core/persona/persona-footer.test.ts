import { describe, expect, it } from "vitest";
import { withSystemFooter } from "./persona-generator.js";

const NOW = new Date("2026-11-09T16:30:00.000Z");

describe("withSystemFooter", () => {
  it("replaces the model's footer with real values in UTC+8", () => {
    const text = "# Team Operating Doctrine\n\n- rule\n\n---\n\n> **最后更新**：2024-05-22 · **来源场景**：1 个 · **记忆总数**：0 条\n\n---";
    const out = withSystemFooter(text, 7, NOW);
    expect(out).not.toContain("2024-05-22");
    expect(out).not.toContain("记忆总数");
    expect(out.endsWith("> **最後更新**：2026-11-10 00:30 (UTC+8) · **來源場景**：7 個")).toBe(true);
    expect(out.match(/最後更新/g)).toHaveLength(1);
  });

  it("adds a footer when the model wrote none", () => {
    expect(withSystemFooter("# Doc\n\n- rule", 3, NOW)).toBe("# Doc\n\n- rule\n\n---\n\n> **最後更新**：2026-11-10 00:30 (UTC+8) · **來源場景**：3 個");
  });
});
