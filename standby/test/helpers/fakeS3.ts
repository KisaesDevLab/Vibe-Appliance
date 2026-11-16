import { S3Client, S3Error } from "../../src/link/s3.ts";

/** In-memory bucket shared by several clients; a client may be read-only, like a read-only key. */
export class FakeBucket { objects = new Map<string, string>(); down = false; }

export class FakeS3 extends S3Client {
  #b: FakeBucket; #readOnly: boolean;
  constructor(bucket: FakeBucket, readOnly = false) {
    super({ endpoint: "http://fake", bucket: "b", prefix: "", keyId: "id", key: "fake-secret-key" });
    this.#b = bucket; this.#readOnly = readOnly;
  }
  #up(): void { if (this.#b.down) throw new Error("fetch failed"); }
  override async put(name: string, data: string): Promise<void> {
    this.#up();
    if (this.#readOnly) throw new S3Error(`write of ${name}`, 403, "<Code>AccessDenied</Code>");
    this.#b.objects.set(name, data);
  }
  override async get(name: string): Promise<string | null> { this.#up(); return this.#b.objects.get(name) ?? null; }
  override async list(dir: string): Promise<string[]> { this.#up(); return [...this.#b.objects.keys()].filter((k) => k.startsWith(`${dir}/`)).sort(); }
}
