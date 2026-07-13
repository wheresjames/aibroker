import { describe, expect, it } from "vitest";
import { claimNextJob, isDurableJob, recoverInterruptedJobs, validateJobPayload } from "./jobs.js";

describe("job validation", () => {
  it("classifies write-adjacent connector jobs as durable", () => {
    expect(isDurableJob("server.connection_test")).toBe(true);
    expect(isDurableJob("server.bulk_connection_test")).toBe(true);
    expect(isDurableJob("server.capability_refresh")).toBe(true);
    expect(isDurableJob("host.wp_cli")).toBe(true);
    expect(isDurableJob("host.session")).toBe(true);
    expect(isDurableJob("server.plugin_inventory")).toBe(false);
    expect(isDurableJob("cache.refresh")).toBe(false);
  });

  it("rejects unknown job names", () => {
    expect(() => validateJobPayload("unknown", {})).toThrow("Unknown job kind");
  });

  it("rejects job kinds the database worker does not implement", () => {
    expect(() => validateJobPayload("server.plugin_inventory", {})).toThrow("Unknown job kind");
  });

  it("atomically claims the next runnable PostgreSQL job", async () => {
    let sql = "";
    const job = { id: "j1", kind: "server.capability_refresh", server_id: "s1", payload: {} };
    const claimed = await claimNextJob({ query: async (statement) => { sql = statement; return { rows: [job] }; } });
    expect(claimed).toEqual(job);
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain("attempt_count = attempt_count + 1");
    expect(sql).toContain("for update skip locked");
  });

  it("returns null when no database job is runnable", async () => {
    await expect(claimNextJob({ query: async () => ({ rows: [] }) })).resolves.toBeNull();
  });
  it("recovers stale durable work after a worker restart",async()=>{const sql:string[]=[];await recoverInterruptedJobs({query:async(statement)=>{sql.push(statement);return{};}});expect(sql.join(" ")).toContain("worker_restarted");expect(sql.join(" ")).toContain("host_operations");});
});
