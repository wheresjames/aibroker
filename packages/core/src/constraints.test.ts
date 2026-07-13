import { describe, expect, it } from "vitest";
import { constraintsAllowInput, intersectConstraints, validateBindingConstraints, validateConstraints } from "./constraints.js";

describe("constraints", () => {
  it("intersects narrowing numeric and set constraints", () => {
    expect(
      intersectConstraints(
        "wordpress.list_pages",
        { maxResults: 50, allowedStatuses: ["publish", "draft"] },
        { maxResults: 25, allowedStatuses: ["publish"] }
      )
    ).toEqual({ maxResults: 25, allowedStatuses: ["publish"] });
  });

  it("rejects widening constraints", () => {
    expect(() => intersectConstraints("wordpress.list_pages", { maxResults: 25 }, { maxResults: 50 })).toThrow("constraint_widening:maxResults");
    expect(() =>
      intersectConstraints("wordpress.list_pages", { allowedStatuses: ["publish"] }, { allowedStatuses: ["publish", "draft"] })
    ).toThrow("constraint_widening:allowedStatuses");
  });

  it("rejects unknown and non-applicable keys", () => {
    expect(() => validateConstraints("wordpress.list_pages", { unknown: true })).toThrow("unknown_constraint:unknown");
    expect(() => validateConstraints("wordpress.get_page", { maxResults: 10 })).toThrow("constraint_not_applicable:maxResults");
    expect(() => validateBindingConstraints({ unknown: true })).toThrow("unknown_constraint:unknown");
  });

  it("ignores binding constraints that do not apply to the evaluated tool", () => {
    expect(intersectConstraints("wordpress.get_page", {}, { maxResults: 10 })).toEqual({});
  });

  it("checks constrained tool input", () => {
    expect(constraintsAllowInput({ maxResults: 10, allowedStatuses: ["publish"] }, { limit: 11, status: ["publish"] })).toBe(false);
    expect(constraintsAllowInput({ maxResults: 10, allowedStatuses: ["publish"] }, { limit: 5, status: ["draft"] })).toBe(false);
    expect(constraintsAllowInput({ maxResults: 10, allowedStatuses: ["publish"] }, { limit: 5, status: ["publish"] })).toBe(true);
  });

  it("accepts an optional visible backup freshness prerequisite only for destructive operations", () => {
    expect(validateConstraints("database_import", { requiredBackupMaxAgeHours: 24 })).toEqual({ requiredBackupMaxAgeHours: 24 });
    expect(() => validateConstraints("database_list_tables", { requiredBackupMaxAgeHours: 24 })).toThrow("constraint_not_applicable");
  });
});
