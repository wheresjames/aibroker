import { describe, expect, it } from "vitest";
import type pg from "pg";
import { enqueueHostOperation, executeIdempotent } from "./server.js";

// A saturated pool: all ten requests acquire their transaction connection before
// any action runs. Acquiring another connection is an error, not a timed hang.
function boundedPool(failInsert = false) {
  let acquired = 0;
  let released = 0;
  const statements: string[] = [];
  const db = {
    async connect() {
      if (++acquired > 10) throw new Error("pool exhausted");
      return {
        async query(sql: string) {
          statements.push(sql);
          if (sql.includes("insert into jobs") && failInsert) throw new Error("job insert failed");
          if (sql.includes("from idempotency_keys")) return { rows: [], rowCount: 0 };
          return { rows: [{ id: "id" }], rowCount: 1 };
        },
        release() { released++; }
      };
    },
    async query() { throw new Error("action requested another pool connection"); }
  } as unknown as pg.Pool;
  return { db, statements, connections: () => ({ acquired, released }) };
}

const actor = { userId: "user", tokenId: "token", role: "user", status: "active", groupIds: [] };

describe("queued write transactions", () => {
  it("enqueues concurrent writes using only their existing connections", async () => {
    const pool = boundedPool();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => executeIdempotent(
      pool.db, "token", "server", "ssh.create_file", `key-${i}`, "hash",
      (client) => enqueueHostOperation(pool.db, actor, "server", "ssh.create_file", {}, "ssh", "plugin", client)
    )));
    expect(results).toHaveLength(10);
    expect(results.every((result) => result.status === "queued")).toBe(true);
    expect(pool.connections()).toEqual({ acquired: 10, released: 10 });
    expect(pool.statements.filter((sql) => sql === "begin")).toHaveLength(10);
    expect(pool.statements.filter((sql) => sql === "commit")).toHaveLength(10);
  });

  it("rolls back the enclosing transaction when enqueueing fails", async () => {
    const pool = boundedPool(true);
    await expect(executeIdempotent(pool.db, "token", "server", "ssh.create_file", "key", "hash",
      (client) => enqueueHostOperation(pool.db, actor, "server", "ssh.create_file", {}, "ssh", "plugin", client)
    )).rejects.toThrow("job insert failed");
    expect(pool.statements.filter((sql) => sql === "rollback")).toHaveLength(1);
    expect(pool.statements).not.toContain("commit");
    expect(pool.statements.some((sql) => sql.includes("insert into idempotency_keys"))).toBe(false);
    expect(pool.connections()).toEqual({ acquired: 1, released: 1 });
  });
});
