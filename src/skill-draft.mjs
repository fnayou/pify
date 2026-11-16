import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { readApprovedProcedure } from "./memory-approvals.mjs";
import { authorizePifyAction } from "./permissions.mjs";

const DRAFT_NAME = "SKILL.pify-draft.md";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const inside = (child, root) => child === root || child.startsWith(`${root}${path.sep}`);

async function destinationFor(destinationDir, vaultPath) {
  if (typeof destinationDir !== "string" || !path.isAbsolute(destinationDir)) {
    throw new Error("Absolute draft skill directory is required");
  }
  const name = path.basename(destinationDir);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || name.endsWith("-")) {
    throw new Error("Draft directory name must be a lowercase skill slug");
  }
  const parent = await fs.realpath(path.dirname(path.resolve(destinationDir)));
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Unsafe draft parent directory");
  const directory = path.join(parent, name);
  if (inside(directory, vaultPath)) throw new Error("Draft destination must be outside the memory vault");
  let exists = false;
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Draft destination is not a regular directory");
    exists = true;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (exists) {
    for (const file of ["SKILL.md", DRAFT_NAME]) {
      try { await fs.lstat(path.join(directory, file)); throw new Error(`Draft destination already contains ${file}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return { directory, name, exists, draftPath: path.join(directory, DRAFT_NAME) };
}

function draftContent(name, sourceContent) {
  return `---\nname: ${name}\ndescription: Draft from an approved local procedure; review before use.\ndisable-model-invocation: true\n---\n\n# ${name}\n\n${sourceContent.endsWith("\n") ? sourceContent : `${sourceContent}\n`}`;
}

export function skillDraftTarget(vaultPath, relativePath, directory) {
  return `memory/skill-draft/${digest(`${vaultPath}\0${relativePath}\0${directory}`)}`;
}

/** Review one approved procedure and the exact inactive draft destination. */
export async function previewSkillDraft({ agentDir, relativePath, destinationDir }) {
  const source = await readApprovedProcedure({ agentDir, relativePath });
  const destination = await destinationFor(destinationDir, source.vaultPath);
  const content = draftContent(destination.name, source.content);
  const plan = { vaultPath: source.vaultPath, relativePath, sourceDigest: source.digest,
    directory: destination.directory, draftPath: destination.draftPath, content };
  return { status: "review", ...plan, reviewCode: digest(JSON.stringify(plan)) };
}

/** Create a draft file outside Pi skill discovery after exact review and scope approval. */
export async function createSkillDraft({ agentDir, relativePath, destinationDir, reviewCode, permission }) {
  const preview = await previewSkillDraft({ agentDir, relativePath, destinationDir });
  if (reviewCode !== preview.reviewCode) throw new Error("Approved procedure or draft destination changed after review");
  const decision = authorizePifyAction({ permission, action: {
    kind: "memory-skill-draft", targets: [skillDraftTarget(preview.vaultPath, relativePath, preview.directory)],
  } });
  if (decision.outcome !== "allowed") return decision;

  const destination = await destinationFor(preview.directory, preview.vaultPath);
  let createdDirectory = false;
  if (!destination.exists) {
    await fs.mkdir(destination.directory, { mode: 0o700 });
    createdDirectory = true;
  }
  let temporary = null;
  try {
    await destinationFor(preview.directory, preview.vaultPath);
    temporary = path.join(destination.directory, `.pify-draft-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(preview.content); await handle.sync(); }
    finally { await handle.close(); }
    await fs.link(temporary, preview.draftPath);
    return { status: "draft_created", draftPath: preview.draftPath, active: false };
  } finally {
    if (temporary) await fs.rm(temporary, { force: true });
    if (createdDirectory) {
      try { await fs.rmdir(destination.directory); }
      catch (error) { if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error; }
    }
  }
}
