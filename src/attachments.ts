/**
 * User-supplied reference material: UI mockups, API specs, screenshots.
 *
 * On the sandbox question: `repoTools` refuses any path outside the repo, and
 * that restriction is about what the AGENT may reach on its own initiative.
 * An attachment is the opposite direction — the user handing a file over
 * deliberately, which is the same trust level as pasting the content into the
 * prompt. So attachments may come from anywhere on disk, but because the
 * content leaves the machine for a third-party API, anything outside the repo
 * is surfaced for confirmation and obvious secrets are refused outright.
 *
 * Attachments are never exposed as a tool. The agent cannot ask for one.
 */

import fs from "node:fs";
import path from "node:path";

export type AttachmentKind = "image" | "pdf-text" | "text";

export interface Attachment {
  /** Absolute path on disk. */
  source: string;
  /** What the user sees in logs and prompts. */
  label: string;
  kind: AttachmentKind;
  /** For images: a data URI. For text kinds: the extracted text. */
  content: string;
  bytes: number;
  /** Rough token cost, for budgeting before the call is made. */
  estimatedTokens: number;
  /** True when the file came from outside the repo. */
  outsideRepo: boolean;
}

const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".csv", ".xml", ".html",
]);

/** 10 MB for one file. Big enough for a mockup or a spec, small enough to notice. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Guards against a whole directory of specs quietly becoming a five-figure bill. */
const MAX_TOTAL_TOKENS = 120_000;

/**
 * Files that must never be shipped to a model API, matched on name rather than
 * content so the check is cheap and predictable. This is deliberately blunt:
 * the cost of a false positive is retyping a path, the cost of a false negative
 * is a leaked credential.
 */
const SECRET_PATTERNS: RegExp[] = [
  /(^|[/\\])\.env($|\.)/i,
  /(^|[/\\])\.npmrc$/i,
  /(^|[/\\])\.netrc$/i,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|[/\\])credentials(\.json)?$/i,
  /(^|[/\\])secrets?\./i,
  /\.(pem|key|p12|pfx|keystore|jks|ppk)$/i,
  /(^|[/\\])\.aws([/\\]|$)/i,
  /(^|[/\\])\.ssh([/\\]|$)/i,
];

export class AttachmentError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** Cheap heuristic: ~4 characters per token for prose and code. */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Image cost varies by provider tiling, but every major one lands near this for
 * a typical screenshot. Used only to warn before spending, never for billing.
 */
function estimateImageTokens(): number {
  return 1200;
}

function looksSecret(abs: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(abs));
}

async function extractPdfText(abs: string): Promise<{ text: string; pages: number }> {
  // The legacy build is the one that runs under Node without a DOM or a worker.
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(abs));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map((it: any) => it.str ?? "").join(" ").replace(/\s+/g, " ").trim();
    if (text) parts.push(`--- page ${i} ---\n${text}`);
  }
  return { text: parts.join("\n\n"), pages: doc.numPages };
}

/**
 * Turn one user-named path into something a model can consume. Throws
 * AttachmentError with a usable hint rather than a stack trace.
 */
export async function loadAttachment(rawPath: string, repoRoot: string): Promise<Attachment> {
  const abs = path.resolve(rawPath);

  if (!fs.existsSync(abs)) {
    throw new AttachmentError(`No such file: ${rawPath}`);
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    throw new AttachmentError(`${rawPath} is a directory.`, "Attach individual files.");
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new AttachmentError(
      `${path.basename(abs)} is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`
    );
  }
  if (looksSecret(abs)) {
    throw new AttachmentError(
      `Refusing to attach ${path.basename(abs)} — it looks like a credential file.`,
      "Attachments are sent to your model provider. If this really is reference material, copy the non-secret part into a separate file."
    );
  }

  const root = path.resolve(repoRoot);
  const outsideRepo = !abs.toLowerCase().startsWith(
    (root.endsWith(path.sep) ? root : root + path.sep).toLowerCase()
  );
  const label = outsideRepo ? abs : path.relative(root, abs).replace(/\\/g, "/");
  const ext = path.extname(abs).toLowerCase();

  if (IMAGE_EXT[ext]) {
    const b64 = fs.readFileSync(abs).toString("base64");
    return {
      source: abs,
      label,
      kind: "image",
      content: `data:${IMAGE_EXT[ext]};base64,${b64}`,
      bytes: stat.size,
      estimatedTokens: estimateImageTokens(),
      outsideRepo,
    };
  }

  if (ext === ".pdf") {
    let extracted: { text: string; pages: number };
    try {
      extracted = await extractPdfText(abs);
    } catch (err: any) {
      throw new AttachmentError(`Could not read ${path.basename(abs)}: ${err.message}`);
    }
    if (!extracted.text.trim()) {
      throw new AttachmentError(
        `${path.basename(abs)} has no extractable text — it is probably a scan or pure images.`,
        "Export the pages as PNGs and attach those instead."
      );
    }
    return {
      source: abs,
      label: `${label} (${extracted.pages} page${extracted.pages === 1 ? "" : "s"})`,
      kind: "pdf-text",
      content: extracted.text,
      bytes: stat.size,
      estimatedTokens: estimateTextTokens(extracted.text),
      outsideRepo,
    };
  }

  if (TEXT_EXT.has(ext) || ext === "") {
    const text = fs.readFileSync(abs, "utf-8");
    return {
      source: abs,
      label,
      kind: "text",
      content: text,
      bytes: stat.size,
      estimatedTokens: estimateTextTokens(text),
      outsideRepo,
    };
  }

  throw new AttachmentError(
    `Don't know how to read ${ext || "a file with no extension"}.`,
    `Supported: ${Object.keys(IMAGE_EXT).join(", ")}, .pdf, and plain text.`
  );
}

export async function loadAttachments(paths: string[], repoRoot: string): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const p of paths) out.push(await loadAttachment(p, repoRoot));

  const total = out.reduce((n, a) => n + a.estimatedTokens, 0);
  if (total > MAX_TOTAL_TOKENS) {
    throw new AttachmentError(
      `Attachments come to roughly ${total.toLocaleString()} tokens, over the ${MAX_TOTAL_TOKENS.toLocaleString()} cap.`,
      "Attach fewer files, or trim the large ones."
    );
  }
  return out;
}

/** One line per attachment, so the cost is visible before the call goes out. */
export function describeAttachments(list: Attachment[]): string[] {
  if (list.length === 0) return [];
  const lines = [`Attached ${list.length} reference${list.length === 1 ? "" : "s"}:`];
  for (const a of list) {
    const kind = a.kind === "image" ? "image" : a.kind === "pdf-text" ? "PDF text" : "text";
    const warn = a.outsideRepo ? "  [outside repo]" : "";
    lines.push(`  ${a.label} — ${kind}, ~${a.estimatedTokens.toLocaleString()} tokens${warn}`);
  }
  const total = list.reduce((n, a) => n + a.estimatedTokens, 0);
  lines.push(`  Total ~${total.toLocaleString()} tokens, sent once to the planner.`);
  return lines;
}

export function hasImages(list: Attachment[]): boolean {
  return list.some((a) => a.kind === "image");
}

/**
 * Build the user message. Text attachments are inlined so text-only models can
 * use them; images become content blocks, which forces the array form.
 */
export function buildUserContent(prompt: string, list: Attachment[]): string | any[] {
  const textual = list.filter((a) => a.kind !== "image");
  const images = list.filter((a) => a.kind === "image");

  let text = prompt;
  if (textual.length > 0) {
    const blocks = textual.map(
      (a) => `--- REFERENCE: ${a.label} ---\n${a.content}\n--- END REFERENCE ---`
    );
    text = `${prompt}\n\nThe user supplied these reference documents. Treat them as\nauthoritative for the requirements they describe:\n\n${blocks.join("\n\n")}`;
  }

  if (images.length === 0) return text;

  const imageNote = images.map((a) => a.label).join(", ");
  return [
    { type: "text", text: `${text}\n\nThe user also attached ${images.length} image(s): ${imageNote}. Use them as the visual reference for this work.` },
    ...images.map((a) => ({ type: "image_url", image_url: { url: a.content } })),
  ];
}
