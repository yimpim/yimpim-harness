/**
 * Reassembles files sent from a paired phone.
 *
 * Chunks arrive as ordinary encrypted commands, so they inherit the pairing and
 * AEAD guarantees already in place — only the one paired device can send them,
 * and the relay only ever sees ciphertext.
 *
 * What this layer adds is containment. A phone is an input device, not a
 * filesystem client: the incoming name is reduced to a bare basename, the
 * extension must be one we can actually render as model input, the write lands
 * in a fixed staging folder under the repo, and both the per-file and
 * per-session totals are capped so a runaway sender cannot fill the disk.
 */

import fs from "node:fs";
import path from "node:path";

/** Only formats the attachment layer can turn into model input. */
const ALLOWED: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SESSION_BYTES = 40 * 1024 * 1024;
/** An upload that stalls mid-transfer should not pin memory forever. */
const UPLOAD_TTL_MS = 5 * 60 * 1000;

interface PendingUpload {
  name: string;
  mime: string;
  total: number;
  chunks: Map<number, Buffer>;
  bytes: number;
  startedAt: number;
}

export interface CompletedUpload {
  /** Absolute path of the staged file. */
  filePath: string;
  name: string;
  bytes: number;
}

/**
 * Strip every directory component and anything that could escape the staging
 * folder. A phone never chooses where a file lands.
 */
function safeName(raw: string, mime: string): string {
  const base = path.basename(String(raw ?? "")).replace(/[^A-Za-z0-9._-]/g, "_");
  const trimmed = base.replace(/^[._]+/, "").slice(0, 80) || "upload";
  const wanted = ALLOWED[mime];
  return path.extname(trimmed).toLowerCase() === wanted ? trimmed : `${trimmed}${wanted}`;
}

export class UploadCollector {
  private pending = new Map<string, PendingUpload>();
  private sessionBytes = 0;
  private dir: string;

  constructor(repoRoot: string) {
    this.dir = path.join(repoRoot, ".agent", "attachments");
  }

  /**
   * Feed one chunk. Returns the finished file when the last chunk lands,
   * or undefined while more are outstanding. Throws on anything malformed.
   */
  accept(c: {
    uploadId: string; name: string; mime: string; seq: number; total: number; data: string;
  }): CompletedUpload | undefined {
    this.sweepExpired();

    if (!ALLOWED[c.mime]) {
      throw new Error(`unsupported type ${c.mime}`);
    }
    if (!Number.isInteger(c.total) || c.total < 1 || c.total > 4096) {
      throw new Error("bad chunk count");
    }
    if (!Number.isInteger(c.seq) || c.seq < 0 || c.seq >= c.total) {
      throw new Error("bad chunk index");
    }

    let up = this.pending.get(c.uploadId);
    if (!up) {
      up = {
        name: safeName(c.name, c.mime),
        mime: c.mime,
        total: c.total,
        chunks: new Map(),
        bytes: 0,
        startedAt: Date.now(),
      };
      this.pending.set(c.uploadId, up);
    }
    // A later chunk must not be able to redescribe the file mid-flight.
    if (up.total !== c.total || up.mime !== c.mime) {
      throw new Error("chunk does not match the upload it belongs to");
    }
    if (up.chunks.has(c.seq)) return undefined;

    const buf = Buffer.from(c.data, "base64");
    up.chunks.set(c.seq, buf);
    up.bytes += buf.length;
    this.sessionBytes += buf.length;

    if (up.bytes > MAX_FILE_BYTES) {
      this.pending.delete(c.uploadId);
      throw new Error(`file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }
    if (this.sessionBytes > MAX_SESSION_BYTES) {
      this.pending.delete(c.uploadId);
      throw new Error("session upload limit reached");
    }
    if (up.chunks.size < up.total) return undefined;

    const ordered = Buffer.concat(
      Array.from({ length: up.total }, (_, i) => up!.chunks.get(i)!)
    );
    this.pending.delete(c.uploadId);

    fs.mkdirSync(this.dir, { recursive: true });
    let dest = path.join(this.dir, up.name);
    let n = 1;
    while (fs.existsSync(dest)) {
      const ext = path.extname(up.name);
      dest = path.join(this.dir, `${path.basename(up.name, ext)}-${n++}${ext}`);
    }
    fs.writeFileSync(dest, ordered, { mode: 0o600 });

    return { filePath: dest, name: path.basename(dest), bytes: ordered.length };
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, up] of this.pending) {
      if (now - up.startedAt > UPLOAD_TTL_MS) {
        this.sessionBytes -= up.bytes;
        this.pending.delete(id);
      }
    }
  }
}
