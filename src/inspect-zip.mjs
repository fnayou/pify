import { inflateRawSync } from "node:zlib";

const MAX_ENTRIES = 1000;
const MAX_ARCHIVE_MEMBER_BYTES = 16 * 1024 * 1024;
const MAX_PART_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_PART_BYTES = 8 * 1024 * 1024;

function safeName(name) {
  if (!name || name.length > 1024 || /[\\\x00-\x1f]/.test(name) || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  return name.split("/").every((part) => part !== "." && part !== "..");
}

export function assertSafeArchiveName(name) {
  if (!safeName(name)) throw new Error(`Unsafe archive entry: ${name.slice(0, 120)}`);
}

/** Read ZIP central-directory metadata. No archive member is extracted to disk. */
export function readZip(buffer) {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65557); at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50 && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("Invalid or unsupported ZIP archive");
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) throw new Error("Multi-disk ZIP archives are unsupported");
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  let at = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || at === 0xffffffff) throw new Error("ZIP64 archives are unsupported");
  if (count > MAX_ENTRIES) throw new Error(`ZIP archive exceeds ${MAX_ENTRIES} entries`);
  if (at + size > end) throw new Error("Invalid ZIP central directory");
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("Invalid ZIP central directory entry");
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const sizeBytes = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const externalMode = buffer.readUInt32LE(at + 38) >>> 16;
    const localOffset = buffer.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end || compressedSize === 0xffffffff || sizeBytes === 0xffffffff || localOffset === 0xffffffff) throw new Error("Invalid or ZIP64 archive entry");
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
    assertSafeArchiveName(name);
    if (flags & 1) throw new Error("Encrypted ZIP entries are unsupported");
    if ((externalMode & 0xf000) === 0xa000) throw new Error(`ZIP symlink entry is unsupported: ${name.slice(0, 120)}`);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method: ${method}`);
    if (sizeBytes > MAX_ARCHIVE_MEMBER_BYTES || (sizeBytes > 1024 * 1024 && sizeBytes > compressedSize * 1000)) {
      throw new Error(`ZIP member exceeds safe size or compression ratio: ${name.slice(0, 120)}`);
    }
    entries.push({ name, sizeBytes, compressedSize, method, localOffset });
    at = next;
  }
  if (at !== buffer.readUInt32LE(end + 16) + size) throw new Error("Invalid ZIP central directory size");
  return entries;
}

function readPart(buffer, entry) {
  if (entry.sizeBytes > MAX_PART_BYTES || entry.compressedSize > MAX_PART_BYTES) throw new Error(`Office part exceeds ${MAX_PART_BYTES} bytes: ${entry.name.slice(0, 120)}`);
  const at = entry.localOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) throw new Error("Invalid ZIP local header");
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const localName = buffer.subarray(at + 30, at + 30 + nameLength).toString("utf8");
  if (localName !== entry.name || buffer.readUInt16LE(at + 8) !== entry.method || buffer.readUInt16LE(at + 6) & 1) {
    throw new Error("ZIP local header differs from its central directory");
  }
  const start = at + 30 + nameLength + extraLength;
  if (start + entry.compressedSize > buffer.length) throw new Error("Truncated ZIP member");
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  const data = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_PART_BYTES });
  if (data.length !== entry.sizeBytes) throw new Error("ZIP member size mismatch");
  return data.toString("utf8");
}

function decodeXml(text) {
  return text.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (match, number, named) => {
    if (named) return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[named.toLowerCase()];
    const code = number[0].toLowerCase() === "x" ? parseInt(number.slice(1), 16) : parseInt(number, 10);
    return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

function tagText(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g"))]
    .map((match) => decodeXml(match[1].replace(/<[^>]+>/g, ""))).join(" ");
}

export function inspectOffice(buffer, format) {
  const entries = readZip(buffer);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const parts = format === "docx" ? ["word/document.xml"] :
    format === "pptx" ? entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name)).map((entry) => entry.name).sort() :
    entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)).map((entry) => entry.name).sort();
  if (!parts.length || (format === "docx" && !byName.has(parts[0]))) throw new Error(`Invalid ${format.toUpperCase()} document`);
  let used = 0;
  const load = (name) => {
    const entry = byName.get(name);
    if (!entry) return "";
    used += entry.sizeBytes;
    if (used > MAX_TOTAL_PART_BYTES) throw new Error("Office document parts exceed the read limit");
    return readPart(buffer, entry);
  };
  let shared = [];
  if (format === "xlsx" && byName.has("xl/sharedStrings.xml")) {
    shared = [...load("xl/sharedStrings.xml").matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)]
      .slice(0, 10000).map((match) => tagText(match[1], "t"));
  }
  const snippets = [];
  let text = "";
  let truncated = parts.length > 3;
  for (const name of parts.slice(0, 3)) {
    const xml = load(name);
    let value;
    if (format === "docx") value = tagText(xml.replace(/<\/w:p>/g, "\n"), "w:t");
    else if (format === "pptx") value = tagText(xml, "a:t");
    else {
      const cells = [...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].slice(0, 80);
      value = cells.map((match) => {
        const ref = /\br="([^"]+)"/.exec(match[1])?.[1] ?? "cell";
        const raw = /<v>([\s\S]*?)<\/v>/.exec(match[2])?.[1] ?? tagText(match[2], "t");
        const cell = /\bt="s"/.test(match[1]) ? shared[Number(raw)] ?? "" : decodeXml(raw);
        return `${ref}: ${cell}`;
      }).join("; ");
      if (cells.length === 80) truncated = true;
    }
    if (value.length > 4000 - text.length) truncated = true;
    snippets.push({ part: name, text: value.slice(0, Math.max(0, 4000 - text.length)) });
    text += value.slice(0, Math.max(0, 4000 - text.length));
  }
  return { summary: { partCount: parts.length, snippets }, truncated };
}

export function inspectZipArchive(buffer) {
  const entries = readZip(buffer);
  return {
    summary: {
      entryCount: entries.length,
      entries: entries.slice(0, 30).map(({ name, sizeBytes }) => ({ name: name.slice(0, 120), sizeBytes })),
    },
    truncated: entries.length > 30,
  };
}
