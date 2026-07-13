import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredArtifact {
  key: string;
  size: number;
  sha256: string;
}

export interface ArtifactStore {
  readonly backend: "filesystem" | "s3";
  put(data: Uint8Array, maxBytes: number): Promise<StoredArtifact>;
  get(key: string, maxBytes: number): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  health(): Promise<void>;
}

function checked(data: Uint8Array, maxBytes: number): { size: number; sha256: string } {
  if (data.byteLength <= 0 || data.byteLength > maxBytes) throw new Error("artifact_size_exceeded");
  return { size: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
}

function safeKey(key: string): string {
  if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error("invalid_artifact_key");
  return key;
}

export class FilesystemArtifactStore implements ArtifactStore {
  readonly backend = "filesystem" as const;
  constructor(private readonly root: string) {}
  async put(data: Uint8Array, maxBytes: number): Promise<StoredArtifact> {
    const digest = checked(data, maxBytes), key = randomUUID();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.root, `.${key}.tmp`), target = path.join(this.root, key);
    try { await writeFile(temporary, data, { mode: 0o600, flag: "wx" }); await rename(temporary, target); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
    return { key, ...digest };
  }
  async get(key: string, maxBytes: number): Promise<Uint8Array> {
    const file = path.join(this.root, safeKey(key));
    const info = await stat(file); if (info.size > maxBytes) throw new Error("artifact_size_exceeded");
    return readFile(file);
  }
  async delete(key: string): Promise<void> { await rm(path.join(this.root, safeKey(key)), { force: true }); }
  async health(): Promise<void> { await mkdir(this.root, { recursive: true, mode: 0o700 }); await stat(this.root); }
}

export interface S3ArtifactStoreOptions {
  endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string;
}

/** Minimal path-style SigV4 client so the broker does not need a cloud-vendor SDK. */
export class S3ArtifactStore implements ArtifactStore {
  readonly backend = "s3" as const;
  constructor(private readonly options: S3ArtifactStoreOptions) {}
  async put(data: Uint8Array, maxBytes: number): Promise<StoredArtifact> {
    const digest = checked(data, maxBytes), key = randomUUID();
    const response = await this.request("PUT", key, data);
    if (!response.ok) throw new Error(`artifact_store_error:${response.status}`);
    return { key, ...digest };
  }
  async get(key: string, maxBytes: number): Promise<Uint8Array> {
    const response = await this.request("GET", safeKey(key));
    if (!response.ok) throw new Error(response.status === 404 ? "artifact_not_found" : `artifact_store_error:${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > maxBytes) throw new Error("artifact_size_exceeded");
    const data = new Uint8Array(await response.arrayBuffer()); checked(data, maxBytes); return data;
  }
  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", safeKey(key));
    if (!response.ok && response.status !== 404) throw new Error(`artifact_store_error:${response.status}`);
  }
  async health(): Promise<void> {
    const response = await this.request("HEAD", ""); if (!response.ok) throw new Error(`artifact_store_error:${response.status}`);
  }
  private async request(method: string, key: string, body?: Uint8Array): Promise<Response> {
    const base = new URL(this.options.endpoint); base.pathname = `/${this.options.bucket}${key ? `/${key}` : ""}`;
    const now = new Date(), amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), date = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update(body ?? new Uint8Array()).digest("hex");
    const canonicalHeaders = `host:${base.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonical = [method, base.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/${this.options.region}/s3/aws4_request`;
    const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`;
    const hmac = (keyValue: Buffer | string, value: string) => createHmac("sha256", keyValue).update(value).digest();
    const signing = hmac(hmac(hmac(hmac(`AWS4${this.options.secretAccessKey}`, date), this.options.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signing).update(toSign).digest("hex");
    return fetch(base, { method, headers: {
      "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    }, ...(body ? { body: Buffer.from(body) } : {}) });
  }
}
