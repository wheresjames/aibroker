import { describe, expect, it } from "vitest";
import { formatToastForClipboard, formatToastHistoryForClipboard } from "./components.js";
import type { ToastItem } from "./types.js";

const first: ToastItem = {
  id: 1,
  text: "Policy save succeeded",
  tone: "success",
  createdAt: new Date("2026-07-13T10:00:00.000Z")
};

describe("toast history clipboard formatting", () => {
  it("formats one message with its timestamp and tone", () => {
    expect(formatToastForClipboard(first)).toBe("[2026-07-13T10:00:00.000Z] SUCCESS Policy save succeeded");
  });

  it("copies the complete history in displayed order", () => {
    const second: ToastItem = { ...first, id: 2, text: "Connection failed", tone: "error" };
    expect(formatToastHistoryForClipboard([second, first])).toBe(
      "[2026-07-13T10:00:00.000Z] ERROR Connection failed\n[2026-07-13T10:00:00.000Z] SUCCESS Policy save succeeded"
    );
  });
});
