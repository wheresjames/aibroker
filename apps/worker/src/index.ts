import pg from "pg";
import { loadConfig, redactObject, redactValue } from "@aibroker/core";
import { decryptJson, loadEncryptionKey, type EncryptedPayload } from "@aibroker/crypto";
import { WordPressRestClient } from "@aibroker/wordpress-rest";
import { recordServerPluginCapabilities } from "@aibroker/db";
import { claimNextJob, recoverInterruptedJobs, validateJobPayload, type DurableJob } from "./jobs.js";
import { buildNetworkCommand, buildRecoveryCommand, buildWorkspaceCommand, buildWpCliCommand, executeSshCommand, parseWpCliJson, runSshSession, type NetworkTool, type RecoveryTool, type WpCliTool } from "@aibroker/wpcli-ssh";
import { executeReviewedProvider } from "./provider-adapters.js";

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
let stopping = false;

async function testSite(serverId: string): Promise<void> {
  const result = await pool.query<{
    base_url: string; server_plugin_id: string; credential_id: string; encrypted_payload: EncryptedPayload; expires_at: string | null;
  }>(
    `select replace(coalesce(sp.config->>'base_url','http://'||s.address),'\${server.address}',s.address) as base_url,sp.id as server_plugin_id,
            c.id as credential_id,c.encrypted_payload,c.expires_at
     from servers s join server_plugins sp on sp.server_id=s.id and sp.plugin_key='wordpress' and sp.status='enabled' join lateral (
       select id, encrypted_payload, expires_at from server_credentials
       where server_plugin_id = sp.id and kind = 'wordpress_rest_application_password' and status = 'active'
         and (expires_at is null or expires_at > now()) order by created_at desc limit 1
     ) c on true where s.id = $1 and s.status = 'active'`,
    [serverId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Active server credential not found");
  const credentials = decryptJson<{ username: string; applicationPassword: string }>(row.encrypted_payload, loadEncryptionKey(config.encryptionKeyBase64));
  const client = new WordPressRestClient({ baseUrl: row.base_url, credentials, allowPrivateTargets: config.allowPrivateConnectorTargets });
  const started = Date.now();
  try {
    // Discovery reports availability only — it never touches policy or bindings.
    const discovery = await client.discoverCapabilities();
    await recordServerPluginCapabilities(pool,row.server_plugin_id,[
      {capability:"rest_reachable",status:discovery.reachable?"available":"unavailable",executorKind:"rest",credentialId:row.credential_id},
      {capability:"rest_authenticated",status:discovery.authenticated?"available":"unavailable",executorKind:"rest",credentialId:row.credential_id},
      {capability:"media_upload",status:discovery.mediaSupported?"available":"unavailable",executorKind:"rest",credentialId:row.credential_id}
    ]);
    if (!discovery.reachable || !discovery.authenticated) {
      const code = discovery.errorCode ?? "connector_unavailable";
      await pool.query("insert into server_connection_tests (server_id, credential_id, status, error_code, error_message, duration_ms) values ($1,$2,'error',$3,$4,$5)", [serverId, row.credential_id, code, (discovery.errorMessage ?? "connection failed").slice(0, 500), Date.now() - started]);
      throw new Error(discovery.errorMessage ?? "REST connection failed");
    }
    await pool.query("insert into server_connection_tests (server_id, credential_id, status, duration_ms) values ($1,$2,'ok',$3)", [serverId, row.credential_id, Date.now() - started]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "connection failed";
    await pool.query("insert into server_connection_tests (server_id, credential_id, status, error_code, error_message, duration_ms) values ($1,$2,'error',$3,$4,$5)", [serverId, row.credential_id, "connector_unavailable", message.slice(0, 500), Date.now() - started]);
    throw err;
  }
}


async function processJob(job: DurableJob): Promise<void> {
  validateJobPayload(job.kind, job.payload);
  if (job.kind === "server.capability_refresh" || job.kind === "server.connection_test") {
    if (!job.server_id) throw new Error("Job requires a server");
    await testSite(job.server_id);
  } else if (job.kind === "server.bulk_connection_test") {
    const servers = await pool.query<{ id: string }>("select id from servers where status = 'active'");
    for (const server of servers.rows) await testSite(server.id);
  } else if (job.kind === "host.wp_cli") {
    await executeHostOperation(job);
  } else if (job.kind === "host.session") {
    // Sessions have their own long-lived execution lifecycle and must not block the
    // durable operation claim loop.
    void executeHostSession(job).catch((error) => console.error(JSON.stringify({ level:"error",message:"Host session failed",session_id:job.payload.session_id,error:error instanceof Error?error.message:String(error) })));
  } else if(job.kind === "provider.operation") {
    await executeProviderOperation(job);
  } else if(job.kind === "database.operation") {
    await executeDatabaseOperation(job);
  } else {
    throw new Error(`Job kind ${job.kind} is not implemented`);
  }
}

async function executeDatabaseOperation(job: DurableJob): Promise<void> {
  const operationId = String(job.payload.operation_id ?? "");
  if (!operationId || !job.server_id) throw new Error("Database operation payload is incomplete");
  const operation = await pool.query<{ server_plugin_id: string; tool_name: string; input: Record<string, unknown>; actor_user_id: string | null; actor_token_id: string | null; reason: string | null }>(
    "select server_plugin_id,tool_name,input,actor_user_id,actor_token_id,reason from host_operations where id=$1 and status='queued'", [operationId]
  );
  const row = operation.rows[0]; if (!row || row.tool_name !== "postgres.run_sql") return;
  const connector = await pool.query<{ credential_id: string; encrypted_payload: EncryptedPayload }>(
    `select pc.credential_id,sc.encrypted_payload from postgres_connectors pc join server_credentials sc on sc.id=pc.credential_id
     where pc.server_plugin_id=$1 and sc.status='active'`, [row.server_plugin_id]
  );
  if (!connector.rows[0]) throw Object.assign(new Error("Postgres scoped credential unavailable"), { code: "postgres_credential_missing" });
  const credential = decryptJson<{ connectionString: string }>(connector.rows[0].encrypted_payload, loadEncryptionKey(config.encryptionKeyBase64));
  const database = new pg.Pool({ connectionString: credential.connectionString, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 120_000 });
  await pool.query("update host_operations set status='running',started_at=now(),progress='{\"percent\":5}'::jsonb,updated_at=now() where id=$1", [operationId]);
  const started = Date.now();
  try {
    const sql = String(row.input.sql ?? ""); if (!sql || !row.reason?.trim()) throw new Error("SQL and justification are required");
    const result = await database.query(sql, Array.isArray(row.input.parameters) ? row.input.parameters : []);
    const captured = { command: result.command, row_count: result.rowCount, rows: result.rows };
    await appendOperationLog(operationId, "stdout", JSON.stringify(captured));
    await pool.query(`insert into audit_events(request_id,event_type,actor_user_id,actor_token_id,server_id,tool_name,status,input_summary,duration_ms,executor_kind,operation_id,reason,tool_domain,tool_action,tool_risk)
      values($1,'database_operation',$2,$3,$4,$5,'success',$6::jsonb,$7,'postgres',$8,$9,'postgres_data','operate','critical')`,
      [`database:${operationId}`,row.actor_user_id,row.actor_token_id,job.server_id,row.tool_name,JSON.stringify({sql,row_count:result.rowCount}),Date.now()-started,operationId,row.reason]);
    await pool.query("update host_operations set status='succeeded',progress='{\"percent\":100}'::jsonb,result=$2::jsonb,finished_at=now(),updated_at=now() where id=$1",
      [operationId, JSON.stringify(captured)]);
    await pool.query("update server_credentials set last_used_at=now() where id=$1", [connector.rows[0].credential_id]);
    await pool.query("update postgres_connectors set connection_status='available',last_tested_at=now(),updated_at=now() where server_plugin_id=$1", [row.server_plugin_id]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "database operation failed";
    await appendOperationLog(operationId, "stderr", message);
    await pool.query("update host_operations set status='failed',error_code='postgres_execution_failed',error_message=$2,finished_at=now(),updated_at=now() where id=$1", [operationId, message.slice(0, 500)]);
    await pool.query("update postgres_connectors set connection_status='unavailable',last_tested_at=now(),updated_at=now() where server_plugin_id=$1", [row.server_plugin_id]);
    throw err;
  } finally { credential.connectionString = ""; await database.end(); }
}

async function executeProviderOperation(job:DurableJob):Promise<void>{
  const operationId=String(job.payload.operation_id??"");if(!operationId||!job.server_id)throw new Error("Provider operation payload is incomplete");
  const op=await pool.query<{tool_name:string;input:Record<string,unknown>;actor_user_id:string|null;actor_token_id:string|null;reason:string|null}>("select tool_name,input,actor_user_id,actor_token_id,reason from host_operations where id=$1 and status='queued'",[operationId]);const row=op.rows[0];if(!row)return;
  const provider=await pool.query<{id:string;base_url:string;adapter_id:string;encrypted_payload:EncryptedPayload;credential_id:string}>(`select p.id,p.base_url,p.adapter_id,c.encrypted_payload,c.id credential_id from hosting_providers p join server_credentials c on c.id=p.credential_id where p.server_id=$1 and c.status='active'`,[job.server_id]);const configured=provider.rows[0];if(!configured)throw new Error("Hosting provider unavailable");
  if(configured.adapter_id!=="aibroker_v1")throw new Error("Hosting adapter is not reviewed");
  const credential=decryptJson<{token:string}>(configured.encrypted_payload,loadEncryptionKey(config.encryptionKeyBase64));await pool.query("update host_operations set status='running',started_at=now() where id=$1",[operationId]);
  try{const started=Date.now();const result=await executeReviewedProvider({tool:row.tool_name,baseUrl:configured.base_url,token:credential.token,input:redactObject(row.input),...(typeof row.input.idempotency_key==="string"?{idempotencyKey:row.input.idempotency_key}:{}),allowPrivateTargets:config.allowPrivateConnectorTargets});
    await pool.query("insert into provider_operation_events(operation_id,provider_reference,status,details) values($1,$2,$3,$4::jsonb)",[operationId,result.providerReference??null,result.status,JSON.stringify(redactValue(result.result))]);
    await pool.query(`insert into audit_events(request_id,event_type,actor_user_id,actor_token_id,server_id,tool_name,status,input_summary,duration_ms,executor_kind,operation_id,reason) values($1,'provider_operation',$2,$3,$4,$5,'success',$6::jsonb,$7,'hosting',$8,$9)`,[`provider:${operationId}`,row.actor_user_id,row.actor_token_id,job.server_id,row.tool_name,JSON.stringify(redactObject(row.input)),Date.now()-started,operationId,row.reason]);
    await pool.query("update host_operations set status='succeeded',progress='{\"percent\":100}'::jsonb,result=$2::jsonb,finished_at=now(),updated_at=now() where id=$1",[operationId,JSON.stringify(redactValue(result.result))]);
    if(row.tool_name==="hosting_deploy"||row.tool_name==="hosting_rollback")await pool.query("insert into deployments(server_id,provider_id,operation_id,provider_reference,environment,status,finished_at) values($1,$2,$3,$4,$5,$6,now())",[job.server_id,configured.id,operationId,result.providerReference??null,String(row.input.environment??"default"),result.status]);
    await pool.query("update server_credentials set last_used_at=now() where id=$1",[configured.credential_id]);
    await pool.query("update hosting_providers set status='available',last_discovered_at=now() where id=$1",[configured.id]);
  }catch(error){await pool.query("update hosting_providers set status='unavailable',last_discovered_at=now() where id=$1",[configured.id]);await pool.query("update host_operations set status='failed',error_code=$2,error_message=$3,finished_at=now(),updated_at=now() where id=$1",[operationId,"provider_error",error instanceof Error?error.message.slice(0,500):"provider failed"]);throw error;}finally{credential.token="";}
}

async function executeHostSession(job: DurableJob): Promise<void> {
  const sessionId = String(job.payload.session_id ?? ""); if (!sessionId || !job.server_id) throw new Error("Session payload is incomplete");
  const result = await pool.query<{ credential_id: string; encrypted_payload: EncryptedPayload; host: string; port: number; username: string; max_session_seconds: number; recording_enabled: boolean;mode:string;unrestricted_sudo:boolean;actor_user_id:string|null;actor_token_id:string|null;reason:string|null;started_at:string }>(
    `select hs.credential_id,sc.encrypted_payload,c.host,c.port,c.username,c.max_session_seconds,hs.recording_enabled,hs.mode,c.unrestricted_sudo,hs.actor_user_id,hs.actor_token_id,hs.reason,hs.started_at
     from host_sessions hs join ssh_connectors c on c.server_id=hs.server_id and (hs.server_plugin_id is null or c.server_plugin_id=hs.server_plugin_id) join server_credentials sc on sc.id=hs.credential_id
     where hs.id=$1 and hs.status='starting' and sc.status='active'`,[sessionId]);
  const row=result.rows[0]; if(!row) throw new Error("Session connector is unavailable");
  const credential=decryptJson<{privateKey:string;passphrase?:string;knownHostsLine:string}>(row.encrypted_payload,loadEncryptionKey(config.encryptionKeyBase64));
  let lastInput=0,totalOutput=0;
  await pool.query("update host_sessions set status='active',last_activity_at=now() where id=$1",[sessionId]);
  try {
    const exitCode=await runSshSession({host:row.host,port:row.port,username:row.username,privateKey:credential.privateKey,...(credential.passphrase?{passphrase:credential.passphrase}:{}),knownHostsLine:credential.knownHostsLine,timeoutMs:row.max_session_seconds*1000,...(row.mode==="root_access"&&row.username!=="root"&&row.unrestricted_sudo?{initialCommand:["sudo","-n","-i"]}:{}),
      onOutput:async(chunk)=>{ totalOutput+=chunk.length; if(totalOutput>10*1024*1024){await pool.query("update host_sessions set recording_truncated=true where id=$1",[sessionId]);return;} if(row.recording_enabled) await pool.query("insert into host_session_stream(session_id,direction,content) values($1,'output',$2)",[sessionId,chunk]); await pool.query("update host_sessions set last_activity_at=now() where id=$1",[sessionId]); },
      readInput:async()=>{const input=await pool.query<{id:number;content:Buffer}>("select id,content from host_session_stream where session_id=$1 and direction='input' and id>$2 order by id limit 100",[sessionId,lastInput]); if(input.rows.length) lastInput=input.rows[input.rows.length-1]!.id; return input.rows.map(r=>r.content);},
      shouldStop:async()=>{const state=await pool.query<{status:string;credential_status:string}>("select hs.status,sc.status credential_status from host_sessions hs join server_credentials sc on sc.id=hs.credential_id where hs.id=$1",[sessionId]); return !state.rows[0]||state.rows[0].status!=='active'||state.rows[0].credential_status!=='active';}
    });
    await pool.query("update host_sessions set status='ended',ended_at=now() where id=$1 and status='active'",[sessionId]);
    await pool.query("insert into host_session_stream(session_id,direction,content) values($1,'system',convert_to($2,'UTF8'))",[sessionId,`SSH session exited with ${exitCode}`]);
    await pool.query(`insert into audit_events(request_id,event_type,actor_user_id,actor_token_id,server_id,tool_name,status,input_summary,duration_ms,executor_kind,session_id,reason)
      values($1,'host_session_end',$2,$3,$4,$5,'success',$6::jsonb,greatest(0,extract(epoch from (now()-$7::timestamptz))*1000)::int,'host_session',$8,$9)`,[`session:${sessionId}:end`,row.actor_user_id,row.actor_token_id,job.server_id,row.mode==="root_access"?"host_session_root":`host_session_${row.mode}`,JSON.stringify({host:row.host,username:row.username,exit_code:exitCode}),row.started_at,sessionId,row.reason]);
  } catch(error){await pool.query("update host_sessions set status='failed',ended_at=now(),recording_failed=$2 where id=$1",[sessionId,row.recording_enabled]);throw error;}
  finally{credential.privateKey="";if(credential.passphrase)credential.passphrase="";}
}

async function executeHostOperation(job: DurableJob): Promise<void> {
  const operationId = String(job.payload.operation_id ?? "");
  if (!operationId || !job.server_id) throw new Error("Host operation payload is incomplete");
  const operation = await pool.query<{ tool_name: string; input: Record<string, unknown>; server_plugin_id:string|null;actor_user_id:string|null;actor_token_id:string|null;reason:string|null }>(
    "select tool_name, input, server_plugin_id, actor_user_id, actor_token_id, reason from host_operations where id = $1 and status = 'queued'", [operationId]
  );
  const row = operation.rows[0];
  if (!row) return;
  const connectorResult = await pool.query<{
    credential_id: string; encrypted_payload: EncryptedPayload; host: string; port: number; username: string;
    mode: string; wordpress_path: string | null; wp_cli_path: string; host_key_fingerprint: string;
  }>(`select c.credential_id, sc.encrypted_payload, c.host, c.port, c.username, c.mode, c.wordpress_path, c.wp_cli_path, c.host_key_fingerprint
      from ssh_connectors c join server_credentials sc on sc.id = c.credential_id
      where c.server_id = $1 and sc.status = 'active' and ($2::uuid is null or c.server_plugin_id=$2)`, [job.server_id, row.server_plugin_id]);
  const connector = connectorResult.rows[0];
  if (!connector) throw Object.assign(new Error("Active SSH connector not found"), { code: "credential_missing" });
  if (connector.mode !== "typed_wp_cli" && connector.mode !== "constrained_shell" && connector.mode !== "full_shell" && connector.mode !== "root_access") throw new Error("Connector mode does not permit WP-CLI");
  const credential = decryptJson<{ privateKey: string; passphrase?: string; knownHostsLine: string }>(connector.encrypted_payload, loadEncryptionKey(config.encryptionKeyBase64));
  let command: string[];
  if(row.tool_name.startsWith("workspace_") || row.tool_name.startsWith("ssh.")){
    if (row.tool_name === "ssh.run_command") {
      const raw = String(row.input.command ?? "").trim();
      if (!raw || !row.reason?.trim()) throw Object.assign(new Error("Break-glass command and reason are required"), { code: "reason_required" });
      command = ["aibroker-break-glass", raw];
    } else {
    const workspaceName=String(row.input.workspace??"");
    const workspace=await pool.query<{remote_root:string;allowed_extensions:string[];max_file_bytes:number;commands:Record<string,string[]>}>("select remote_root,allowed_extensions,max_file_bytes,commands from server_workspaces where server_id=$1 and name=$2",[job.server_id,workspaceName]);
    if(!workspace.rows[0])throw Object.assign(new Error("Workspace not found"),{code:"workspace_unavailable"});
    const mapped = ({
      "ssh.list_files": "workspace_list_files", "ssh.read_file": "workspace_read_file", "ssh.file_hash": "workspace_get_file_hash",
      "ssh.create_file": "workspace_create_file", "ssh.update_file": "workspace_update_file", "ssh.remove_file": "workspace_remove_file",
      "ssh.run_named_command": "workspace_run_command"
    } as Record<string, string>)[row.tool_name] ?? row.tool_name;
    command=buildWorkspaceCommand({tool:mapped,root:workspace.rows[0].remote_root,input:row.input,allowedExtensions:workspace.rows[0].allowed_extensions,maxFileBytes:workspace.rows[0].max_file_bytes,namedCommands:workspace.rows[0].commands});
    }
  }else if(row.tool_name.startsWith("network_"))command=buildNetworkCommand(row.tool_name as NetworkTool,connector.wp_cli_path,connector.wordpress_path,row.input);
  else if(row.tool_name.startsWith("backup_")||row.tool_name.startsWith("database_")||row.tool_name.startsWith("deployment_snapshot_"))command=buildRecoveryCommand(row.tool_name as RecoveryTool,row.input,{wpCliPath:connector.wp_cli_path,wordpressPath:connector.wordpress_path});
  else command = buildWpCliCommand({ tool: row.tool_name as WpCliTool, wpCliPath: connector.wp_cli_path, wordpressPath: connector.wordpress_path, input: row.input });
  await pool.query("select pg_advisory_lock(hashtext($1))", [job.server_id]);
  await pool.query("update host_operations set status = 'running', progress='{\"percent\":5}'::jsonb, started_at = now(), updated_at = now() where id = $1", [operationId]);
  const controller = new AbortController();
  const cancellation = setInterval(async () => {
    const state = await pool.query<{ cancel_requested_at: string | null }>("select cancel_requested_at from host_operations where id = $1", [operationId]);
    if (state.rows[0]?.cancel_requested_at) controller.abort();
  }, 500);
  try {
    const result = await executeSshCommand({ host: connector.host, port: connector.port, username: connector.username, privateKey: credential.privateKey, ...(credential.passphrase ? { passphrase: credential.passphrase } : {}), knownHostsLine: credential.knownHostsLine, command, timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, signal: controller.signal });
    await appendOperationLog(operationId, "stdout", result.stdout);
    await appendOperationLog(operationId, "stderr", result.stderr);
    const parsed = parsePossibleJson(result.stdout);
    if(result.exitCode===0)await recordRecoveryResult(job.server_id,operationId,row.tool_name,row.input,parsed);
    const status = result.exitCode === 0 ? "succeeded" : "failed";
    await pool.query(`insert into audit_events(request_id,event_type,actor_user_id,actor_token_id,server_id,tool_name,status,input_summary,error_code,duration_ms,executor_kind,operation_id,reason)
      values($1,'host_operation',$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,[`operation:${operationId}`,row.actor_user_id,row.actor_token_id,job.server_id,row.tool_name,result.exitCode===0?"success":"failure",JSON.stringify(redactObject(row.input)),result.exitCode===0?null:"ssh_exit",result.durationMs,row.tool_name.startsWith("ssh.")?"ssh":row.tool_name.startsWith("workspace_")?"workspace":"wp_cli",operationId,row.reason]);
    await pool.query("update host_operations set status = $2, progress=$6::jsonb, result = $3::jsonb, exit_code = $4, error_code = $5, finished_at = now(), updated_at = now() where id = $1", [operationId, status, JSON.stringify(parsed), result.exitCode, result.exitCode === 0 ? null : "wp_cli_exit",JSON.stringify({percent:100})]);
    await pool.query("update server_credentials set last_used_at = now() where id = $1", [connector.credential_id]);
    await pool.query("update ssh_connectors set connection_status=$2,last_tested_at=now(),updated_at=now() where server_id=$1",[job.server_id,result.exitCode===0?"available":result.stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")?"host_key_changed":"unavailable"]);
    if (result.exitCode !== 0) throw new Error(`WP-CLI exited with ${result.exitCode}`);
  } catch (error) {
    const code = controller.signal.aborted ? "cancelled" : typeof error === "object" && error && "code" in error ? String(error.code) : "ssh_execution_failed";
    await pool.query("update host_operations set status = $2, error_code = $3, finished_at = now(), updated_at = now() where id = $1 and status = 'running'", [operationId, code === "cancelled" ? "cancelled" : "failed", code]);
    throw error;
  } finally {
    clearInterval(cancellation);
    credential.privateKey = "";
    if (credential.passphrase) credential.passphrase = "";
    await pool.query("select pg_advisory_unlock(hashtext($1))", [job.server_id]);
  }
}

async function recordRecoveryResult(serverId:string,operationId:string,tool:string,input:Record<string,unknown>,result:unknown):Promise<void>{
  const data=result as Record<string,unknown>;
  if(tool==="backup_create"||tool==="deployment_snapshot_create")await pool.query(`insert into backups(server_id,operation_id,kind,status,storage_reference,checksum_sha256,size_bytes,metadata,retention_until) values($1,$2,$3,'available',$4,$5,$6,$7::jsonb,case when $8::int is null then null else now()+($8::text||' days')::interval end)`,[serverId,operationId,tool==="deployment_snapshot_create"?"deployment_snapshot":String(input.kind??"combined"),data.storage_reference??null,data.checksum_sha256??null,data.size_bytes??null,JSON.stringify(redactObject(data)),input.retention_days??null]);
  else if(tool==="backup_verify"&&input.id)await pool.query("update backups set status='verified',verified_at=now(),checksum_sha256=coalesce($2,checksum_sha256) where id=$1 and server_id=$3",[input.id,data.checksum_sha256??null,serverId]);
  else if(tool==="backup_delete"&&input.id)await pool.query("update backups set status='deleted',deleted_at=now() where id=$1 and server_id=$2",[input.id,serverId]);
  else if((tool==="backup_restore"||tool==="deployment_snapshot_restore")&&input.id)await pool.query("insert into restore_history(backup_id,server_id,operation_id,status,finished_at) values($1,$2,$3,'succeeded',now())",[input.id,serverId,operationId]);
  else if(tool==="database_export")await pool.query("insert into database_artifacts(server_id,operation_id,kind,storage_reference,checksum_sha256,metadata) values($1,$2,'export',$3,$4,$5::jsonb)",[serverId,operationId,data.storage_reference??null,data.checksum_sha256??null,JSON.stringify(redactObject(data))]);
}

async function appendOperationLog(operationId: string, stream: "stdout" | "stderr" | "system", content: string): Promise<void> {
  if (content) await pool.query("insert into host_operation_logs(operation_id, stream, content) values ($1,$2,$3)", [operationId, stream, content.slice(0, 1024 * 1024)]);
}

function parsePossibleJson(output: string): unknown {
  try { return parseWpCliJson(output); } catch { return { output: output.trim() }; }
}

async function tick(): Promise<void> {
  const job = await claimNextJob(pool);
  if (!job) return;
  try {
    await processJob(job);
    await pool.query("update jobs set status = 'succeeded', updated_at = now(), last_error = null where id = $1", [job.id]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query("update jobs set status = 'failed', updated_at = now(), last_error = $2 where id = $1", [job.id, message.slice(0, 1000)]);
  }
}

async function run(): Promise<void> {
  await recoverInterruptedJobs(pool);
  console.log(JSON.stringify({ level: "info", message: "AIBroker database worker listening" }));
  while (!stopping) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopping = true; });
run().catch((error) => { console.error(error); process.exit(1); });
