import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const strongKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64");
const production = {
  NODE_ENV: "production",
  AIBROKER_DATABASE_URL: "postgres://localhost/aibroker",
  AIBROKER_SESSION_SECRET: "k3v9Qw2Lr8Zt5Yp1Mx7Nb4Hc6Jd0Fg2Se",
  AIBROKER_BROWSER_WORKER_SECRET: "Tq8Wm3Ze6Ra1Yx9Vc4Bn7Ku2Lp5Hj0Gd",
  AIBROKER_ENCRYPTION_KEY_BASE64: strongKey
} as NodeJS.ProcessEnv;

describe("loadConfig production secrets", () => {
  it("accepts strong secrets", () => {
    expect(loadConfig(production).nodeEnv).toBe("production");
  });

  it.each([
    ["AIBROKER_SESSION_SECRET", "local_development_session_secret_change_me"],
    ["AIBROKER_SESSION_SECRET", "short"],
    ["AIBROKER_BROWSER_WORKER_SECRET", "replace-with-a-strong-browser-worker-secret-value"],
    ["AIBROKER_ENCRYPTION_KEY_BASE64", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="],
    ["AIBROKER_ENCRYPTION_KEY_BASE64", "replace-with-32-byte-base64-key"]
  ])("rejects placeholder %s", (key, value) => {
    expect(() => loadConfig({ ...production, [key]: value })).toThrow(key);
  });

  it("does not enforce outside production", () => {
    expect(() => loadConfig({ ...production, NODE_ENV: "development", AIBROKER_SESSION_SECRET: "dev" })).not.toThrow();
  });
});
