# Bounded local inspection

Pify remains a bootstrap project. Its private Pi package registers `pify_inspect` for one explicitly named local file. Pass `filePath` relative to Pi's current directory or as an absolute path. `mode: "content"` is the default; `mode: "metadata"` reports name, extension, size, and modification time for any regular file.

| Input | Content summary |
| --- | --- |
| PDF | Page count, title, and text from the first three pages via pinned PDF.js |
| DOCX | Text from `word/document.xml` |
| XLSX | Cells from the first three worksheets, including shared strings |
| PPTX | Text from the first three slides |
| CSV | Header and first ten data rows |
| JSON | Type, key or item count, and shallow sample |
| ZIP, TAR, TAR.GZ | Entry count and first 30 entry names and sizes |
| SQLite | First ten table names, columns, and two sample rows per table |

The tool reads at most 16 MiB from one regular file and returns at most 8 KiB of JSON. Each result includes `truncated` and `truncationReason`. Samples, long text, and extra entries report truncation. Unsupported formats and oversized files return clear errors. The file path must name a regular file; symlinks are rejected.

Archive entries are listed in memory. ZIP and TAR path traversal and link entries are rejected. ZIP64, encrypted ZIP, multi-disk ZIP, unsupported compression methods, and extended TAR headers are unsupported. Office readers decompress only selected XML parts, with per-part and total limits. They do not evaluate spreadsheet formulas or read embedded images, charts, or macros.

SQLite opens with Node's `readOnly` option and `PRAGMA query_only`; WAL databases are rejected to avoid sidecar creation. The tool does not run user SQL. It never extracts an archive or writes an inspected file. This is a Pify-mediated reader, not an operating-system sandbox: Pi's built-in tools and other extensions keep their own permissions. File paths may point outside the current project when the caller names them.

PDF extraction uses [`pdfjs-dist` 6.5.438](https://www.npmjs.com/package/pdfjs-dist), licensed Apache-2.0. Pi installs package dependencies for Git and npm sources; local package authors run `npm ci --ignore-scripts` first. Node 22.23.4 in CI provides the [read-only SQLite API](https://nodejs.org/download/release/v22.21.0/docs/api/sqlite.html). The fixture suite covers every format, output bounds, byte-for-byte read-only behavior, oversized input, symlinks, and hostile archives on macOS and Linux.
