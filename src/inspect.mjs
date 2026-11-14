import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { assertSafeArchiveName, inspectOffice, inspectZipArchive } from "./inspect-zip.mjs";

export const MAX_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_TEXT = 4000;

function formatFor(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  const extension = path.extname(lower).slice(1);
  return ({ pdf: "pdf", docx: "docx", xlsx: "xlsx", pptx: "pptx", csv: "csv", json: "json", zip: "zip", tar: "tar", db: "sqlite", sqlite: "sqlite", sqlite3: "sqlite" })[extension] ?? null;
}

function clip(text, limit = MAX_TEXT) {
  const value = String(text);
  return { value: value.slice(0, limit), truncated: value.length > limit };
}

function summarizeJson(value, depth, state) {
  if (depth >= 3 && value && typeof value === "object") {
    state.truncated = true;
    return Array.isArray(value) ? `[array: ${value.length} items]` : `[object: ${Object.keys(value).length} keys]`;
  }
  if (typeof value === "string") {
    const result = clip(value, 160);
    state.truncated ||= result.truncated;
    return result.value;
  }
  if (Array.isArray(value)) {
    state.truncated ||= value.length > 8;
    return { type: "array", length: value.length, sample: value.slice(0, 8).map((item) => summarizeJson(item, depth + 1, state)) };
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    state.truncated ||= keys.length > 8;
    return { type: "object", keyCount: keys.length, sample: Object.fromEntries(keys.slice(0, 8).map((key) => {
      state.truncated ||= key.length > 120;
      return [key.slice(0, 120), summarizeJson(value[key], depth + 1, state)];
    })) };
  }
  return value;
}

function inspectJson(buffer) {
  let parsed;
  try { parsed = JSON.parse(buffer.toString("utf8")); }
  catch { throw new Error("Invalid JSON document"); }
  const state = { truncated: false };
  const summary = summarizeJson(parsed, 0, state);
  return { summary, truncated: state.truncated };
}

function inspectCsv(buffer) {
  const source = buffer.toString("utf8").replace(/^\ufeff/, "");
  const scanLimit = Math.min(source.length, 64 * 1024);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let truncated = source.length > scanLimit;
  for (let at = 0; at < scanLimit; at++) {
    const char = source[at];
    if (char === '"') {
      if (quoted && source[at + 1] === '"') { field += '"'; at++; }
      else if (!field || quoted) quoted = !quoted;
      else throw new Error("Invalid CSV quoting");
    } else if (char === "," && !quoted) {
      row.push(clip(field, 160).value);
      truncated ||= field.length > 160;
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[at + 1] === "\n") at++;
      row.push(clip(field, 160).value);
      truncated ||= field.length > 160;
      rows.push(row);
      row = [];
      field = "";
      if (rows.length >= 11) { truncated ||= at + 1 < source.length; break; }
    } else {
      field += char;
      if (field.length > 4096) throw new Error("CSV field exceeds 4096 characters");
    }
  }
  if (rows.length < 11 && (field || row.length)) {
    if (quoted && scanLimit === source.length) throw new Error("Unclosed CSV quote");
    row.push(clip(field, 160).value);
    truncated ||= field.length > 160;
    rows.push(row);
  }
  return { summary: { columns: rows[0]?.length ?? 0, header: rows[0] ?? [], sampleRows: rows.slice(1, 11), sampledRowCount: Math.max(0, rows.length - 1) }, truncated };
}

async function inspectPdf(buffer) {
  if (!buffer.subarray(0, 8).toString("latin1").startsWith("%PDF-")) throw new Error("Invalid PDF document");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: Uint8Array.from(buffer), useSystemFonts: false, disableFontFace: true, isEvalSupported: false,
    standardFontDataUrl: fileURLToPath(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url)) + path.sep,
  });
  try {
    const document = await loading.promise;
    const pages = [];
    let remaining = MAX_TEXT;
    let truncated = document.numPages > 3;
    for (let number = 1; number <= Math.min(document.numPages, 3) && remaining > 0; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str ?? "").join(" ");
      const excerpt = clip(text, remaining);
      pages.push({ page: number, text: excerpt.value });
      truncated ||= excerpt.truncated;
      remaining -= excerpt.value.length;
      page.cleanup();
    }
    const metadata = await document.getMetadata().catch(() => null);
    return {
      summary: { pageCount: document.numPages, title: clip(metadata?.info?.Title ?? "", 160).value, pages },
      truncated,
    };
  } catch (error) {
    throw new Error(`PDF inspection failed: ${error.message}`);
  } finally {
    await loading.destroy();
  }
}

function inspectTar(buffer, compressed) {
  let data;
  try { data = compressed ? gunzipSync(buffer, { maxOutputLength: MAX_INPUT_BYTES }) : buffer; }
  catch { throw new Error(`TAR.GZ exceeds ${MAX_INPUT_BYTES} byte decompression limit or is invalid`); }
  if (data.length < 1024 || data.length % 512 !== 0) throw new Error("Invalid TAR archive");
  const entries = [];
  for (let at = 0; at + 512 <= data.length;) {
    const header = data.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const parse = (start, size) => header.subarray(start, start + size).toString("utf8").split("\0", 1)[0].trim();
    const expected = parseInt(parse(148, 8), 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (!Number.isFinite(expected) || expected !== actual) throw new Error("Invalid TAR header checksum");
    const name = [parse(345, 155), parse(0, 100)].filter(Boolean).join("/");
    assertSafeArchiveName(name);
    const type = String.fromCharCode(header[156]);
    if (type !== "0" && type !== "\0" && type !== "5") throw new Error(`Unsupported TAR entry type: ${type}`);
    const sizeText = parse(124, 12);
    if (!/^[0-7]*$/.test(sizeText)) throw new Error("Invalid TAR entry size");
    const sizeBytes = parseInt(sizeText || "0", 8);
    const next = at + 512 + Math.ceil(sizeBytes / 512) * 512;
    if (next > data.length) throw new Error("Truncated TAR archive");
    entries.push({ name: name.slice(0, 120), sizeBytes });
    if (entries.length > 1000) throw new Error("TAR archive exceeds 1000 entries");
    at = next;
  }
  return { summary: { entryCount: entries.length, entries: entries.slice(0, 30) }, truncated: entries.length > 30 };
}

function sqliteValue(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[BLOB ${value.length} bytes]`;
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "number") return value;
  return clip(value, 120).value;
}

function inspectSqlite(file, buffer) {
  if (buffer.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") throw new Error("Invalid SQLite database");
  if (buffer[18] === 2 || buffer[19] === 2) throw new Error("SQLite WAL databases are unsupported for read-only inspection");
  const db = new DatabaseSync(file, { readOnly: true, timeout: 0, allowExtension: false });
  try {
    db.exec("PRAGMA query_only = ON");
    const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 21").all();
    const selected = [];
    let truncated = tables.length > 10;
    for (const table of tables.slice(0, 10)) {
      const name = table.name;
      const escaped = name.replaceAll('"', '""');
      const columns = db.prepare(`PRAGMA table_info("${escaped}")`).all().map((column) => column.name);
      const virtual = /^CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql ?? "");
      const sampled = virtual ? [] : db.prepare(`SELECT * FROM "${escaped}" LIMIT 3`).all();
      const rows = sampled.slice(0, 2)
        .map((row) => Object.fromEntries(Object.entries(row).slice(0, 8).map(([key, value]) => [key.slice(0, 80), sqliteValue(value)])));
      truncated ||= columns.length > 8 || sampled.length > 2;
      selected.push({ name: name.slice(0, 120), columns: columns.slice(0, 8), rows, virtual });
    }
    return { summary: { tableCountAtLeast: tables.length, tables: selected }, truncated };
  } finally {
    db.close();
  }
}

/** Inspect one regular local file with fixed input and output bounds. */
export async function inspectLocal({ cwd, filePath, mode = "content" }) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Absolute working directory is required");
  if (typeof filePath !== "string" || !filePath.trim() || filePath.includes("\0")) throw new Error("File path is required");
  if (mode !== "content" && mode !== "metadata") throw new Error("Inspection mode must be content or metadata");
  const file = path.resolve(cwd, filePath);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let info;
  let buffer;
  try {
    info = await handle.stat();
    if (!info.isFile()) throw new Error("Inspection requires a regular file");
    if (info.size > MAX_INPUT_BYTES) throw new Error(`File exceeds ${MAX_INPUT_BYTES} byte read limit`);
    if (mode === "content") {
      buffer = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) throw new Error("File changed during inspection");
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("File changed during inspection");
    }
  } finally {
    await handle.close();
  }
  const format = mode === "metadata" ? "metadata" : formatFor(file);
  if (!format) throw new Error(`Unsupported file format: ${path.extname(file) || "none"}`);
  let inspected;
  if (mode === "metadata") inspected = { summary: { name: path.basename(file), extension: path.extname(file).toLowerCase() || null }, truncated: false };
  else if (format === "pdf") inspected = await inspectPdf(buffer);
  else if (format === "docx" || format === "xlsx" || format === "pptx") inspected = inspectOffice(buffer, format);
  else if (format === "csv") inspected = inspectCsv(buffer);
  else if (format === "json") inspected = inspectJson(buffer);
  else if (format === "zip") inspected = inspectZipArchive(buffer);
  else if (format === "tar" || format === "tar.gz") inspected = inspectTar(buffer, format === "tar.gz");
  else inspected = inspectSqlite(file, buffer);
  const report = {
    schema: "pify.inspect/v1", path: file, format, sizeBytes: info.size,
    modifiedAt: info.mtime.toISOString(), summary: inspected.summary,
    truncated: inspected.truncated, truncationReason: inspected.truncated ? "sample_limit" : null,
  };
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_OUTPUT_BYTES) {
    report.summary = { notice: "Summary exceeded output limit" };
    report.truncated = true;
    report.truncationReason = "output_limit";
  }
  return report;
}
