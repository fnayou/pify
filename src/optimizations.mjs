import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

const CAVEMAN_PACKAGE = /^npm:@caveman-ai\/pi(?:@[^\s]+)?$/;

function absoluteDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`Absolute ${label} is required`);
  return path.resolve(value);
}

async function filePresence(file) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() ? "present" : "conflict";
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    return "unavailable";
  }
}

async function readSettings(file, warnings, label) {
  const presence = await filePresence(file);
  if (presence === "absent") return { status: "absent", value: {} };
  if (presence !== "present") {
    warnings.push(`${label} settings are ${presence}`);
    return { status: "unavailable", value: null };
  }
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
    return { status: "available", value };
  } catch {
    warnings.push(`${label} settings could not be read`);
    return { status: "unavailable", value: null };
  }
}

function cavemanDeclaration(settings) {
  if (settings === null) return "unknown";
  if (settings.packages === undefined) return "not_declared";
  if (!Array.isArray(settings.packages)) return "unknown";
  return settings.packages.some((entry) => {
    const source = typeof entry === "string" ? entry : entry?.source;
    return typeof source === "string" && CAVEMAN_PACKAGE.test(source);
  }) ? "declared" : "not_declared";
}

async function executablePresence(name, pathEnv) {
  for (const directory of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        await fs.access(candidate, constants.X_OK);
        return "present";
      }
    } catch {
      // Continue searching PATH without running any candidate.
    }
  }
  return "not_found";
}

function nativeCompaction(agent, project) {
  if (agent === null || project === null) return { status: "unknown", source: null };
  if (agent.compaction !== undefined && (!agent.compaction || typeof agent.compaction !== "object" || Array.isArray(agent.compaction))) return { status: "unknown", source: "agent" };
  if (project.compaction !== undefined && (!project.compaction || typeof project.compaction !== "object" || Array.isArray(project.compaction))) return { status: "unknown", source: "project" };
  const user = agent.compaction?.enabled;
  const local = project.compaction?.enabled;
  if (local !== undefined) return typeof local === "boolean" ? { status: local ? "enabled" : "disabled", source: "project" } : { status: "unknown", source: "project" };
  if (user !== undefined) return typeof user === "boolean" ? { status: user ? "enabled" : "disabled", source: "agent" } : { status: "unknown", source: "agent" };
  return { status: "enabled", source: "Pi 1.4.0 default" };
}

/** Detect documented Pi optimization entry points without executing or modifying them. */
export async function inspectOptimizations({ agentDir, projectDir, projectTrusted = false, pathEnv = process.env.PATH ?? "" }) {
  const agent = absoluteDirectory(agentDir, "Pi agent directory");
  const project = absoluteDirectory(projectDir, "project directory");
  const warnings = [];
  const [agentSettings, projectSettings, agentRtk, projectRtk, agentCavemanSkill, rtkBinary, cavemanBinary] = await Promise.all([
    readSettings(path.join(agent, "settings.json"), warnings, "Agent"),
    projectTrusted ? readSettings(path.join(project, ".pi", "settings.json"), warnings, "Project") : Promise.resolve({ status: "not_checked_untrusted", value: null }),
    filePresence(path.join(agent, "extensions", "rtk.ts")),
    filePresence(path.join(project, ".pi", "extensions", "rtk.ts")),
    filePresence(path.join(agent, "skills", "caveman", "SKILL.md")),
    executablePresence("rtk", pathEnv),
    executablePresence("caveman", pathEnv),
  ]);
  return {
    schema: "pify.optimizations/v1",
    rtk: {
      binary: rtkBinary,
      agentPiHook: agentRtk,
      projectPiHook: projectRtk,
      projectTrusted,
      compatibility: "unverified",
    },
    caveman: {
      binary: cavemanBinary,
      agentPiPackage: cavemanDeclaration(agentSettings.value),
      projectPiPackage: projectTrusted ? cavemanDeclaration(projectSettings.value) : "not_checked_untrusted",
      agentSkill: agentCavemanSkill,
      enabledByPify: false,
      compatibility: "unverified",
    },
    nativeCompaction: nativeCompaction(agentSettings.value, projectTrusted ? projectSettings.value : null),
    newTransformsEnabledByPify: false,
    warnings,
  };
}
