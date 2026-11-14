import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync, gzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectLocal, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES } from "../src/inspect.mjs";

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, text, mode = 0o100644 } of files) {
    const filename = Buffer.from(name);
    const data = Buffer.from(text);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

function tar(name, text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)]);
}

function pdf(text) {
  const content = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return source;
}

test("inspects every approved format with bounded read-only summaries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pify-inspect-"));
  try {
    const files = {
      "sample.pdf": pdf("Hello PDF"),
      "sample.docx": zip([{ name: "word/document.xml", text: "<w:document><w:p><w:t>Doc words</w:t></w:p></w:document>" }]),
      "sample.xlsx": zip([
        { name: "xl/sharedStrings.xml", text: "<sst><si><t>Sheet words</t></si></sst>" },
        { name: "xl/worksheets/sheet1.xml", text: '<worksheet><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></worksheet>' },
      ]),
      "sample.pptx": zip([{ name: "ppt/slides/slide1.xml", text: "<p:sld><a:t>Slide words</a:t></p:sld>" }]),
      "sample.csv": "name,value\nAda,1\nBéla,2\n",
      "sample.json": JSON.stringify({ name: "Sample", items: [1, 2, 3] }),
      "sample.zip": zip([{ name: "folder/readme.txt", text: "Archive words" }]),
      "sample.tar": tar("folder/readme.txt", "Archive words"),
      "sample.tar.gz": gzipSync(tar("folder/readme.txt", "Archive words")),
    };
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
    const database = path.join(dir, "sample.sqlite");
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE notes (name TEXT, value INTEGER); INSERT INTO notes VALUES ('Ada', 1)");
    db.close();
    const before = Object.fromEntries(await Promise.all((await readdir(dir)).map(async (name) => [name, await readFile(path.join(dir, name))])));
    const expected = {
      "sample.pdf": ["pageCount", "Hello PDF"],
      "sample.docx": ["partCount", "Doc words"],
      "sample.xlsx": ["partCount", "Sheet words"],
      "sample.pptx": ["partCount", "Slide words"],
      "sample.csv": ["header", "Ada"],
      "sample.json": ["keyCount", "Sample"],
      "sample.zip": ["entryCount", "folder/readme.txt"],
      "sample.tar": ["entryCount", "folder/readme.txt"],
      "sample.tar.gz": ["entryCount", "folder/readme.txt"],
      "sample.sqlite": ["notes", "Ada"],
    };
    for (const [name, terms] of Object.entries(expected)) {
      const report = await inspectLocal({ cwd: dir, filePath: name });
      assert.equal(report.schema, "pify.inspect/v1");
      assert.ok(Buffer.byteLength(JSON.stringify(report)) <= MAX_OUTPUT_BYTES, name);
      for (const term of terms) assert.match(JSON.stringify(report.summary), new RegExp(term), name);
    }
    const afterNames = await readdir(dir);
    assert.deepEqual(afterNames.sort(), Object.keys(before).sort());
    for (const name of afterNames) assert.deepEqual(await readFile(path.join(dir, name)), before[name], name);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports truncation and rejects oversized, unsupported, linked, and hostile inputs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pify-inspect-"));
  try {
    await writeFile(path.join(dir, "long.json"), JSON.stringify({ rows: Array.from({ length: 100 }, (_, i) => ({ index: i })) }));
    const json = await inspectLocal({ cwd: dir, filePath: "long.json" });
    assert.equal(json.truncated, true);
    assert.equal(json.truncationReason, "sample_limit");
    await writeFile(path.join(dir, "unknown.bin"), "data");
    await assert.rejects(inspectLocal({ cwd: dir, filePath: "unknown.bin" }), /Unsupported file format/);
    const metadata = await inspectLocal({ cwd: dir, filePath: "unknown.bin", mode: "metadata" });
    assert.equal(metadata.format, "metadata");
    assert.equal(metadata.sizeBytes, 4);
    await writeFile(path.join(dir, "huge.json"), Buffer.alloc(MAX_INPUT_BYTES + 1));
    await assert.rejects(inspectLocal({ cwd: dir, filePath: "huge.json" }), /read limit/);
    await symlink("unknown.bin", path.join(dir, "linked.json"));
    await assert.rejects(inspectLocal({ cwd: dir, filePath: "linked.json" }), /ELOOP|symbolic/i);
    await writeFile(path.join(dir, "escape.zip"), zip([{ name: "../escape.txt", text: "bad" }]));
    await assert.rejects(inspectLocal({ cwd: dir, filePath: "escape.zip" }), /Unsafe archive entry/);
    const bomb = zip([{ name: "bomb.txt", text: "small" }]);
    const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(MAX_INPUT_BYTES + 1, central + 24);
    await writeFile(path.join(dir, "bomb.zip"), bomb);
    await assert.rejects(inspectLocal({ cwd: dir, filePath: "bomb.zip" }), /safe size/);
    await writeFile(path.join(dir, "link.zip"), zip([{ name: "linked.txt", text: "bad", mode: 0o120777 }]));
    await assert.rejects(inspectLocal({ cwd: dir, filePath: "link.zip" }), /symlink/);
    await writeFile(path.join(dir, "escape.tar.gz"), gzipSync(tar("../escape.txt", "bad")));
    await assert.rejects(inspectLocal({ cwd: dir, filePath: "escape.tar.gz" }), /Unsafe archive entry/);
    const walPath = path.join(dir, "wal.sqlite");
    const walDb = new DatabaseSync(walPath);
    walDb.exec("CREATE TABLE t (value TEXT)");
    walDb.close();
    const wal = await readFile(walPath);
    wal[18] = 2;
    await writeFile(walPath, wal);
    await assert.rejects(inspectLocal({ cwd: dir, filePath: "wal.sqlite" }), /WAL databases are unsupported/);
    await writeFile(path.join(dir, "wide.csv"), Array.from({ length: 11 }, () => Array.from({ length: 40 }, () => "x".repeat(60)).join(",")).join("\n"));
    const wide = await inspectLocal({ cwd: dir, filePath: "wide.csv" });
    assert.equal(wide.truncationReason, "output_limit");
    assert.ok(Buffer.byteLength(JSON.stringify(wide)) <= MAX_OUTPUT_BYTES);
    assert.equal((await stat(path.join(dir, "unknown.bin"))).size, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
