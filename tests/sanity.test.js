import { describe, it, expect } from "vitest";
describe("test environment", () => {
  it("runs a trivial passing assertion", () => {
    expect(1 + 1).toBe(2);
  });
});
