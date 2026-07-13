export interface AIBrokerConfig {
  nodeEnv: string;
  apiPort: number;
  webPort: number;
  publicUrl: string;
  databaseUrl: string;
  redisUrl: string;
  sessionSecret: string;
  encryptionKeyBase64: string;
  allowPrivateConnectorTargets: boolean;
  mcpEnabled: boolean;
  mcpCaptureBodies: boolean;
  sandboxEnabled: boolean;
  browserWorkerUrl: string;
  browserWorkerSecret: string;
  browserRpcTimeoutMs: number;
  browserAllowPrivateTargets: boolean;
  artifactBackend: "filesystem" | "s3";
  allowFilesystemArtifacts: boolean;
  artifactFilesystemRoot: string;
  artifactS3Endpoint?: string;
  artifactS3Region?: string;
  artifactS3Bucket?: string;
  artifactS3AccessKeyId?: string;
  artifactS3SecretAccessKey?: string;
  artifactDefaultRetentionSeconds: number;
  artifactMaxRetentionSeconds: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer environment variable ${key}`);
  }
  return parsed;
}

function boolFromEnv(env: NodeJS.ProcessEnv, key: string, fallback = false): boolean {
  const raw = env[key];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AIBrokerConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const artifactBackend = env.AIBROKER_ARTIFACT_BACKEND === "s3" ? "s3" : "filesystem";
  return {
    nodeEnv,
    apiPort: intFromEnv(env, "AIBROKER_API_PORT", 8080),
    webPort: intFromEnv(env, "AIBROKER_WEB_PORT", 3000),
    publicUrl: env.AIBROKER_PUBLIC_URL ?? "http://localhost:8080",
    databaseUrl: required(env, "AIBROKER_DATABASE_URL"),
    redisUrl: env.AIBROKER_REDIS_URL ?? "redis://localhost:6379",
    sessionSecret: required(env, "AIBROKER_SESSION_SECRET"),
    encryptionKeyBase64: required(env, "AIBROKER_ENCRYPTION_KEY_BASE64"),
    allowPrivateConnectorTargets: boolFromEnv(env, "AIBROKER_ALLOW_PRIVATE_CONNECTOR_TARGETS"),
    mcpEnabled: boolFromEnv(env, "AIBROKER_MCP_ENABLED"),
    mcpCaptureBodies: boolFromEnv(env, "AIBROKER_MCP_CAPTURE_BODIES"),
    sandboxEnabled: boolFromEnv(env, "AIBROKER_SANDBOX_ENABLED", nodeEnv !== "production"),
    browserWorkerUrl: env.AIBROKER_BROWSER_WORKER_URL ?? "http://127.0.0.1:8090",
    browserWorkerSecret: nodeEnv === "production" ? required(env, "AIBROKER_BROWSER_WORKER_SECRET") : env.AIBROKER_BROWSER_WORKER_SECRET ?? "local_browser_worker_secret_change_me",
    browserRpcTimeoutMs: intFromEnv(env, "AIBROKER_BROWSER_RPC_TIMEOUT_MS", 35_000),
    browserAllowPrivateTargets: boolFromEnv(env, "AIBROKER_BROWSER_ALLOW_PRIVATE_TARGETS", nodeEnv !== "production"),
    artifactBackend,
    allowFilesystemArtifacts: boolFromEnv(env, "AIBROKER_ALLOW_FILESYSTEM_ARTIFACTS"),
    artifactFilesystemRoot: env.AIBROKER_ARTIFACT_FILESYSTEM_ROOT ?? "/tmp/aibroker-artifacts",
    ...(env.AIBROKER_ARTIFACT_S3_ENDPOINT ? { artifactS3Endpoint: env.AIBROKER_ARTIFACT_S3_ENDPOINT } : {}),
    ...(env.AIBROKER_ARTIFACT_S3_REGION ? { artifactS3Region: env.AIBROKER_ARTIFACT_S3_REGION } : {}),
    ...(env.AIBROKER_ARTIFACT_S3_BUCKET ? { artifactS3Bucket: env.AIBROKER_ARTIFACT_S3_BUCKET } : {}),
    ...(env.AIBROKER_ARTIFACT_S3_ACCESS_KEY_ID ? { artifactS3AccessKeyId: env.AIBROKER_ARTIFACT_S3_ACCESS_KEY_ID } : {}),
    ...(env.AIBROKER_ARTIFACT_S3_SECRET_ACCESS_KEY ? { artifactS3SecretAccessKey: env.AIBROKER_ARTIFACT_S3_SECRET_ACCESS_KEY } : {}),
    artifactDefaultRetentionSeconds: intFromEnv(env, "AIBROKER_ARTIFACT_DEFAULT_RETENTION_SECONDS", 86_400),
    artifactMaxRetentionSeconds: intFromEnv(env, "AIBROKER_ARTIFACT_MAX_RETENTION_SECONDS", 604_800),
  };
}
