import { describe, expect, it } from "vitest";
import { writeAuditEvent } from "./writer.js";

describe("writeAuditEvent", () => {
  it("redacts secret-like input fields before insert", async () => {
    const calls: unknown[][] = [];
    await writeAuditEvent(
      {
        async query(_sql, params) {
          calls.push(params);
          return { rows: [] };
        }
      },
      {
        requestId: "req",
        eventType: "test",
        status: "success",
        input: { token: "secret", safe: "value" }
      }
    );
    expect(JSON.parse(calls[0]![7] as string)).toEqual({ token: "[REDACTED]", safe: "value" });
  });
});
