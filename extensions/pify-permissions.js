import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";

import { buildHealthReport, formatHealthReport } from "../src/health.mjs";
import { inspectLocal } from "../src/inspect.mjs";
import { applyModelSync, MODEL_SYNC_TARGETS, prepareModelSync } from "../src/model-sync.mjs";
import { requestChoice } from "../src/choices.mjs";
import { SessionJobs } from "../src/jobs.mjs";
import { inspectOptimizations } from "../src/optimizations.mjs";
import { authorizePifyAction, modeLabel, permissionContext } from "../src/permissions.mjs";
import { enableProjectWorkflow, inspectProjectWorkflow, WORKFLOW_RESOURCE } from "../src/project-workflow.mjs";
import { searchLocal } from "../src/search.mjs";
import {
  formatGitSetupPreview, formatGitSetupVerification, formatSetupPreview, formatSetupVerification,
  previewGitSetup, previewGitUpdateSetup, previewLocalSetup, verifyGitSetup, verifyLocalSetup,
} from "../src/setup-preview.mjs";
import { inspectThemeSelection, PIFY_THEME, rollbackPifyTheme, selectPifyTheme, THEME_SETTING_RESOURCE } from "../src/theme-selection.mjs";

const execFileAsync = promisify(execFile);
const JOB_START_RESOURCE = "jobs/current-workspace";

export default function (pi) {
  pi.registerFlag("pify-mode", { type: "string", default: "balanced", description: "Pify Safe, Balanced, or Full mode" });
  pi.registerFlag("pify-scope", { type: "string", default: "", description: "Comma-separated exact Pify resource paths" });
  pi.registerFlag("pify-preflight", { type: "boolean", default: false, description: "Preview Pify setup without selecting the fresh theme" });

  const currentPermission = () => permissionContext({
    mode: String(pi.getFlag("pify-mode") ?? "balanced").toLowerCase(),
    authorizedPaths: String(pi.getFlag("pify-scope") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    callerId: "pi-session",
  });
  const agentDir = () => path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
  const themePermission = (permission) => permissionContext({ ...permission, authorizedPaths: [...permission.authorizedPaths, THEME_SETTING_RESOURCE] });
  let jobs = null;
  const sessionJobs = () => jobs ??= new SessionJobs();

  pi.registerTool({
    name: "pify_search",
    label: "Pify search",
    description: "Search filenames or literal file contents in one named directory. Default scope is the current directory. Never follow symlinks or cross filesystem boundaries. At most 200 results and 5000 ms; reports partial results when a limit is reached.",
    promptSnippet: "Bounded filename and literal content search within one named directory",
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("filename"), Type.Literal("content")]),
      query: Type.String(),
      scope: Type.Optional(Type.String({ description: "Directory to search; defaults to the current directory. Name a network mount as this scope to search it." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    }),
    execute: async (_id, params, signal, _onUpdate, ctx) => {
      const result = await searchLocal({ cwd: ctx.cwd, ...params, signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "pify_inspect",
    label: "Pify inspect",
    description: "Inspect one named local file. Supports PDF, DOCX, XLSX, PPTX, CSV, JSON, ZIP, TAR, TAR.GZ, and SQLite; metadata mode works for any regular file. Reads at most 16 MiB and returns a bounded summary with truncation status. Does not extract archives or write databases.",
    promptSnippet: "Bounded read-only local document, archive, and data inspection",
    parameters: Type.Object({
      filePath: Type.String({ description: "Path to one local file, relative to the current directory or absolute" }),
      mode: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("metadata")])),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const result = await inspectLocal({ cwd: ctx.cwd, ...params });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("pify", modeLabel(currentPermission()));
    if (ctx.mode !== "tui" || pi.getFlag("pify-preflight") === true) return;
    try {
      if (ctx.ui.theme.name === "system" && (await inspectThemeSelection({ agentDir: agentDir() })).usePifyOnFreshStart) {
        await selectPifyTheme({ agentDir: agentDir(), permission: themePermission(currentPermission()), approvalSource: "fresh-default" });
        const result = ctx.ui.setTheme(PIFY_THEME);
        if (!result.success) ctx.ui.notify(`Pify theme unavailable: ${result.error}`, "warning");
      }
    } catch (error) {
      ctx.ui.notify(`Pify theme selection unavailable: ${error.message}`, "warning");
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (jobs) {
      await jobs.shutdown();
      jobs = null;
    }
    ctx.ui.setStatus("pify", undefined);
  });

  pi.registerCommand("pify-job", {
    description: "Start, list, inspect, log, or stop a session-bound shell job",
    handler: async (args, ctx) => {
      const [action, id] = args.trim().split(/\s+/, 2);
      const manager = sessionJobs();
      try {
        let result;
        if (action === "start") {
          const command = args.trim().slice("start".length).trim();
          if (!command) throw new Error("Usage: /pify-job start <shell command>");
          let permission = currentPermission();
          if (ctx.mode === "tui") {
            const approved = await ctx.ui.confirm("Start background job?", `Run in ${ctx.cwd}: ${command}`);
            if (!approved) {
              ctx.ui.notify("Job not started", "info");
              return;
            }
            permission = permissionContext({ ...permission, authorizedPaths: [...permission.authorizedPaths, JOB_START_RESOURCE] });
          }
          const decision = authorizePifyAction({ permission, action: { kind: "start-job", targets: [JOB_START_RESOURCE] } });
          result = decision.outcome === "allowed"
            ? await manager.start({ command, cwd: ctx.cwd })
            : { status: "not_started", permission: decision };
        } else if (action === "list") result = manager.list();
        else if (action === "inspect") result = manager.inspect(id);
        else if (action === "log") result = manager.log(id);
        else if (action === "stop") result = await manager.stop(id);
        else throw new Error("Usage: /pify-job <start command|list|inspect id|log id|stop id>");
        ctx.ui.notify(JSON.stringify(result), "info");
      } catch (error) {
        ctx.ui.notify(JSON.stringify({ status: "error", message: error.message }), "warning");
      }
    },
  });

  pi.registerCommand("pify-permission", {
    description: "Show Pify mode and check an exact resource path",
    handler: async (args, ctx) => {
      const permission = currentPermission();
      const target = args.trim();
      const result = authorizePifyAction({
        permission,
        action: { kind: "adopt", targets: target ? [target] : [] },
      });
      ctx.ui.notify(JSON.stringify(result), "info");
    },
  });

  pi.registerCommand("pify-choose", {
    description: "Resolve one missing detail from two to eight choices",
    handler: async (args, ctx) => {
      try {
        const [question, ...options] = args.split("|").map((part) => part.trim());
        const result = await requestChoice({
          question, options, permission: currentPermission(),
          select: ctx.mode === "tui" ? (title, choices) => ctx.ui.select(title, choices) : undefined,
        });
        ctx.ui.notify(JSON.stringify(result), "info");
      } catch (error) {
        ctx.ui.notify(JSON.stringify({ status: "error", message: error.message }), "warning");
      }
    },
  });

  pi.registerCommand("pify-health", {
    description: "Report Pi compatibility, Pify install status, and managed resources",
    handler: async (_args, ctx) => {
      let piVersion = null;
      try {
        const result = await execFileAsync("pi", ["--version"], { timeout: 2000, maxBuffer: 1024 });
        piVersion = result.stdout.trim();
      } catch {
        // Report unknown compatibility while keeping the rest of the check usable.
      }
      const report = await buildHealthReport({ agentDir: agentDir(), projectDir: ctx.cwd, piVersion });
      ctx.ui.notify(ctx.mode === "tui" ? formatHealthReport(report) : JSON.stringify(report), "info");
    },
  });

  pi.registerCommand("pify-model-sync", {
    description: "Preview or explicitly sync Pify-owned LM Studio models",
    handler: async (args, ctx) => {
      const action = args.trim() || "apply";
      if (action !== "preview" && action !== "apply") {
        ctx.ui.notify("Usage: /pify-model-sync [preview|apply]", "warning");
        return;
      }
      let permission = currentPermission();
      if (action === "apply" && ctx.mode !== "tui") {
        const decision = authorizePifyAction({ permission, action: { kind: "model-sync", targets: MODEL_SYNC_TARGETS } });
        if (decision.outcome !== "allowed") {
          ctx.ui.notify(JSON.stringify(decision), "warning");
          return;
        }
      }
      try {
        const plan = await prepareModelSync({ agentDir: agentDir(), projectDir: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
        if (action === "preview") {
          ctx.ui.notify(JSON.stringify(plan.report), "info");
          return;
        }
        let review;
        if (ctx.mode === "tui") {
          const counts = plan.report;
          const approved = await ctx.ui.confirm("Apply LM Studio model sync?",
            plan.report.status === "recovery_required" ? "Restore the configuration from an interrupted sync?" :
              `Add ${counts.added.count}, update ${counts.updated.count}, remove ${counts.removed.count}; ${counts.conflictCount} conflicts. Only Pify-owned entries change.`);
          if (!approved) {
            ctx.ui.notify("LM Studio models unchanged", "info");
            return;
          }
          permission = permissionContext({ ...permission, authorizedPaths: [...permission.authorizedPaths, ...MODEL_SYNC_TARGETS] });
          if (plan.ambiguous?.length) {
            const id = plan.ambiguous[0];
            const selection = await ctx.ui.select(`Manual LM Studio model: ${id.slice(0, 120)}`, ["Keep manual entry", "Cancel sync"]);
            if (selection !== "Keep manual entry") {
              ctx.ui.notify("LM Studio models unchanged", "info");
              return;
            }
            review = { id, decision: "keep" };
          }
        }
        const result = await applyModelSync(plan, { permission, review });
        ctx.ui.notify(JSON.stringify(result), result.status === "clarification_required" ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(JSON.stringify({ status: "conflict", reason: error.message }), "warning");
      }
    },
  });

  pi.registerCommand("pify-setup", {
    description: "Preview or verify the private local or pinned Git Pify package source and Git updates",
    handler: async (args, ctx) => {
      const command = args.trim();
      const verify = /^verify ([a-f0-9]{64})$/.exec(command);
      const previewGit = /^preview-git ([a-f0-9]{40})$/.exec(command);
      const previewUpdateGit = /^preview-update-git ([a-f0-9]{40}) ([a-f0-9]{64}) ([a-f0-9]{40})$/.exec(command);
      const verifyGit = /^verify-git ([a-f0-9]{40}) ([a-f0-9]{64})$/.exec(command);
      if (command !== "preview" && !verify && !previewGit && !previewUpdateGit && !verifyGit) {
        ctx.ui.notify("Usage: /pify-setup preview | verify <review-code> | preview-git <commit> | preview-update-git <from-commit> <from-review-code> <to-commit> | verify-git <commit> <review-code>", "warning");
        return;
      }
      if ((command === "preview" || previewGit || previewUpdateGit) && pi.getFlag("pify-preflight") !== true) {
        ctx.ui.notify(JSON.stringify({ status: "unavailable", reason: "Start a transient Pi session with --pify-preflight before preview" }), "warning");
        return;
      }
      try {
        const report = verify ? await verifyLocalSetup({ agentDir: agentDir(), expectedReviewCode: verify[1] }) :
          previewUpdateGit ? await previewGitUpdateSetup({ agentDir: agentDir(), fromCommit: previewUpdateGit[1], fromReviewCode: previewUpdateGit[2], toCommit: previewUpdateGit[3] }) :
          previewGit ? await previewGitSetup({ agentDir: agentDir(), commit: previewGit[1] }) :
          verifyGit ? await verifyGitSetup({ agentDir: agentDir(), commit: verifyGit[1], expectedReviewCode: verifyGit[2] }) :
          await previewLocalSetup({ agentDir: agentDir() });
        const formatted = verify ? formatSetupVerification(report) :
          previewGit || previewUpdateGit ? formatGitSetupPreview(report) :
          verifyGit ? formatGitSetupVerification(report) : formatSetupPreview(report);
        ctx.ui.notify(ctx.mode === "tui" ? formatted : JSON.stringify(report), "info");
      } catch (error) {
        ctx.ui.notify(JSON.stringify({ status: "error", message: error.message }), "warning");
      }
    },
  });

  pi.registerCommand("pify-optimizations", {
    description: "Inspect existing Pi optimizations without changing them",
    handler: async (_args, ctx) => {
      const report = await inspectOptimizations({
        agentDir: agentDir(),
        projectDir: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      ctx.ui.notify(ctx.mode === "tui"
        ? `RTK hook files: agent ${report.rtk.agentPiHook}, project ${report.rtk.projectPiHook}. Caveman Pi package: agent ${report.caveman.agentPiPackage}, project ${report.caveman.projectPiPackage}. Pify transforms: off.`
        : JSON.stringify(report), "info");
    },
  });

  pi.registerCommand("pify-workflow", {
    description: "Inspect or enable Pify's development workflow for this project",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (!action || action === "status") {
        const status = await inspectProjectWorkflow({ projectDir: ctx.cwd });
        ctx.ui.notify(ctx.mode === "tui" ? `Project workflow: ${status.status}` : JSON.stringify(status), "info");
        return;
      }
      if (action !== "enable") {
        ctx.ui.notify("Usage: /pify-workflow [status|enable]", "warning");
        return;
      }
      let permission = currentPermission();
      if (ctx.mode === "tui") {
        const approved = await ctx.ui.confirm("Enable project workflow?", `Create .pi/${WORKFLOW_RESOURCE} in ${ctx.cwd}?`);
        if (!approved) {
          ctx.ui.notify("Project workflow unchanged", "info");
          return;
        }
        permission = permissionContext({ ...permission, authorizedPaths: [...permission.authorizedPaths, WORKFLOW_RESOURCE] });
      }
      try {
        const result = await enableProjectWorkflow({ projectDir: ctx.cwd, permission });
        const message = result.status === "enabled" ? { ...result, next: "Run /reload and grant project trust" } : result;
        ctx.ui.notify(ctx.mode === "tui" ? `Project workflow: ${message.status}${message.next ? `. ${message.next}.` : ""}` : JSON.stringify(message), "info");
      } catch (error) {
        ctx.ui.notify(ctx.mode === "tui" ? `Project workflow unchanged: ${error.message}` : JSON.stringify({ status: "conflict", reason: error.message }), "warning");
      }
    },
  });

  pi.registerCommand("pify-theme", {
    description: "Inspect, select, or roll back the Pify theme",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (!["status", "enable", "rollback"].includes(action)) {
        ctx.ui.notify("Usage: /pify-theme [status|enable|rollback]", "warning");
        return;
      }
      try {
        const before = await inspectThemeSelection({ agentDir: agentDir() });
        if (action === "status") {
          ctx.ui.notify(ctx.mode === "tui"
            ? `Active theme: ${ctx.ui.theme.name ?? "unknown"}; saved theme: ${before.theme ?? "system"}; Pify rollback: ${before.rollbackAvailable ? "available" : "unavailable"}`
            : JSON.stringify(before), "info");
          return;
        }
        let permission = currentPermission();
        if (ctx.mode === "tui") {
          if (action === "enable" && !ctx.ui.getTheme(PIFY_THEME)) throw new Error("Pify theme is not loaded");
          const approved = await ctx.ui.confirm(
            action === "enable" ? "Select Pify theme?" : "Roll back Pify theme?",
            action === "enable"
              ? `Change ${THEME_SETTING_RESOURCE} theme from ${before.theme ?? "system"} to ${PIFY_THEME}?`
              : `Restore the previous theme in ${THEME_SETTING_RESOURCE}?`,
          );
          if (!approved) {
            ctx.ui.notify("Theme unchanged", "info");
            return;
          }
          permission = themePermission(permission);
        }
        const result = action === "enable"
          ? await selectPifyTheme({ agentDir: agentDir(), permission, approvalSource: ctx.mode === "tui" ? "tui-confirmation" : "explicit-scope" })
          : await rollbackPifyTheme({ agentDir: agentDir(), permission });
        if (ctx.mode === "tui" && (result.status === "selected" || result.status === "rolled-back")) {
          const switched = ctx.ui.setTheme(action === "enable" ? PIFY_THEME : result.theme ?? "system");
          if (!switched.success) ctx.ui.notify(`Saved theme changed; run /reload: ${switched.error}`, "warning");
        }
        ctx.ui.notify(ctx.mode === "tui" ? `Pify theme: ${result.status}` : JSON.stringify(result), "info");
      } catch (error) {
        ctx.ui.notify(ctx.mode === "tui" ? `Theme unchanged: ${error.message}` : JSON.stringify({ status: "conflict", reason: error.message }), "warning");
      }
    },
  });
}
