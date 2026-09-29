const DURABLE_JOB_KINDS = new Set([
  "server.connection_test",
  "server.bulk_connection_test",
  "server.capability_refresh",
  "host.wp_cli",
  "host.session",
  "provider.operation",
  "database.operation"
]);

export function validateJobPayload(jobName: string, payload: unknown): void {
  if (!DURABLE_JOB_KINDS.has(jobName)) {
    throw new Error(`Unknown job kind ${jobName}`);
  }
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Job payload must be an object");
  }
}

export function isDurableJob(jobName: string): boolean {
  return DURABLE_JOB_KINDS.has(jobName);
}

export type DurableJob = { id: string; kind: string; server_id: string | null; payload: Record<string, unknown> };

export async function claimNextJob(db: { query: (sql: string) => Promise<{ rows: DurableJob[] }> }): Promise<DurableJob | null> {
  const result = await db.query(
    `update jobs set status = 'running', attempt_count = attempt_count + 1, updated_at = now()
     where id = (select id from jobs where status = 'queued' and coalesce(run_after, now()) <= now()
                 order by created_at for update skip locked limit 1)
     returning id, kind, server_id, payload`
  );
  return result.rows[0] ?? null;
}

type JobDb = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

export async function recoverInterruptedJobs(db: JobDb): Promise<void> {
  // Recover the job and its operation atomically: another worker must not claim
  // the job while the operation still says running.
  await db.query(`with recovered as (
    update jobs set status='queued',run_after=now(),updated_at=now(),last_error='worker_restarted'
    where status='running' and updated_at<now()-interval '5 minutes' and kind<>'host.session'
    returning id
  )
  update host_operations set status='queued',started_at=null,updated_at=now(),error_code=null
  where status='running' and cancel_requested_at is null and job_id in (select id from recovered)`);
}

export function startJobHeartbeat(db: JobDb, jobId: string, onError: (error: unknown) => void): () => Promise<void> {
  let pending: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (pending) return;
    pending = db.query("update jobs set updated_at=now() where id=$1 and status='running'", [jobId])
      .catch(onError).finally(() => { pending = undefined; });
  }, 30_000);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}

// Called from the claim loop, including when there are no queued jobs. A job
// skipped immediately after restart will therefore be reconsidered when stale.
export function createJobRecovery(db: JobDb): () => Promise<void> {
  let nextRecovery = 0;
  return async () => {
    if (Date.now() < nextRecovery) return;
    await recoverInterruptedJobs(db);
    nextRecovery = Date.now() + 30_000;
  };
}
