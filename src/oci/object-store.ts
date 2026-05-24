import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { InvestigationJob } from "../types.js";

export type PutJsonOptions = {
  ifNotExists?: boolean;
};

export type JsonObjectStore = {
  getJson<T>(key: string): Promise<T | undefined>;
  listJson<T>(prefix: string): Promise<T[]>;
  putJson<T>(key: string, value: T, options?: PutJsonOptions): Promise<boolean>;
};

export const objectKeyForDedupe = (dedupeKey: string) =>
  `dedupe/${createHash("sha256").update(dedupeKey).digest("hex")}.json`;

export const objectKeyForJob = (jobId: string) => `jobs/${encodeURIComponent(jobId)}.json`;

export const objectKeyForSlackMarker = (job: InvestigationJob, marker: "final" | "processing") => {
  const key = job.dedupeKey ?? `${job.source?.provider ?? "job"}:${job.id}`;
  return `slack/${marker}/${createHash("sha256").update(key).digest("hex")}.json`;
};

const errorStatus = (error: unknown) => {
  const value = error as { statusCode?: number; status?: number; code?: string };
  return value.statusCode ?? value.status;
};

const isMissing = (error: unknown) => errorStatus(error) === 404;

const isConflict = (error: unknown) => {
  const status = errorStatus(error);
  return status === 409 || status === 412;
};

const streamToString = async (value: unknown): Promise<string> => {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");

  if (value instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of value) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  if (value && typeof (value as ReadableStream).getReader === "function") {
    const response = new Response(value as ReadableStream);
    return response.text();
  }

  if (value === undefined || value === null) return "";
  return String(value);
};

type OciObjectStorageClientLike = {
  getObject(request: {
    bucketName: string;
    namespaceName: string;
    objectName: string;
  }): Promise<{ value?: unknown }>;
  listObjects(request: {
    bucketName: string;
    namespaceName: string;
    prefix?: string;
    start?: string;
  }): Promise<{ listObjects: { nextStartWith?: string; objects: Array<{ name: string }> } }>;
  putObject(request: {
    bucketName: string;
    contentLength?: number;
    ifNoneMatch?: string;
    namespaceName: string;
    objectName: string;
    putObjectBody: string;
  }): Promise<unknown>;
};

export class OciObjectJsonStore implements JsonObjectStore {
  constructor(
    private readonly client: OciObjectStorageClientLike,
    private readonly options: {
      bucketName: string;
      namespaceName: string;
    },
  ) {}

  async getJson<T>(key: string): Promise<T | undefined> {
    try {
      const response = await this.client.getObject({
        bucketName: this.options.bucketName,
        namespaceName: this.options.namespaceName,
        objectName: key,
      });
      const content = await streamToString(response.value);
      return JSON.parse(content) as T;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async listJson<T>(prefix: string): Promise<T[]> {
    const values: T[] = [];
    let start: string | undefined;
    do {
      const response = await this.client.listObjects({
        bucketName: this.options.bucketName,
        namespaceName: this.options.namespaceName,
        prefix,
        start,
      });
      for (const object of response.listObjects.objects) {
        const value = await this.getJson<T>(object.name);
        if (value) values.push(value);
      }
      start = response.listObjects.nextStartWith;
    } while (start);
    return values;
  }

  async putJson<T>(key: string, value: T, options: PutJsonOptions = {}): Promise<boolean> {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    try {
      await this.client.putObject({
        bucketName: this.options.bucketName,
        contentLength: Buffer.byteLength(body),
        ifNoneMatch: options.ifNotExists ? "*" : undefined,
        namespaceName: this.options.namespaceName,
        objectName: key,
        putObjectBody: body,
      });
      return true;
    } catch (error) {
      if (options.ifNotExists && isConflict(error)) return false;
      throw error;
    }
  }
}

export class InMemoryJsonObjectStore implements JsonObjectStore {
  private readonly objects = new Map<string, unknown>();

  async getJson<T>(key: string): Promise<T | undefined> {
    return this.objects.get(key) as T | undefined;
  }

  async listJson<T>(prefix: string): Promise<T[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value as T);
  }

  async putJson<T>(key: string, value: T, options: PutJsonOptions = {}): Promise<boolean> {
    if (options.ifNotExists && this.objects.has(key)) return false;
    this.objects.set(key, value);
    return true;
  }
}
