import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";

import { applyAtomicCommits, previewAtomicCommits } from "../src/atomic-commits.mjs";
import { buildHealthReport, formatHealthReport } from "../src/health.mjs";
import { applyEdit, previewEdit } from "../src/edit-previews.mjs";
import { listGitConflicts, previewGitConflict, resolveGitConflict } from "../src/git-conflicts.mjs";
import { inspectLocal } from "../src/inspect.mjs";
import { applyModelSync, MODEL_SYNC_TARGETS, prepareModelSync } from "../src/model-sync.mjs";
import { requestChoice } from "../src/choices.mjs";
import { JOB_START_RESOURCE, SessionJobs } from "../src/jobs.mjs";
import { approveMemoryNote, buildPreferenceSnapshot, memoryApprovalTarget, previewMemoryNote, revokeMemoryNote } from "../src/memory-approvals.mjs";
import { connectMemoryVault, createMemoryVault, inspectMemoryVault, MEMORY_STATE_RESOURCE, memoryVaultTargets, resolveMemoryVaultPath, skipMemoryVault } from "../src/memory-vault.mjs";
import { memorySyncTarget, previewMemoryPush, pullMemory, pushMemory } from "../src/memory-sync.mjs";
import { inspectOptimizations } from "../src/optimizations.mjs";
import { authorizePifyAction, authorizeShellAction, clarificationResult, modeLabel, permissionContext, SHELL_COMMAND_RESOURCE } from "../src/permissions.mjs";
import { disableProjectWorkflow, enableProjectWorkflow, inspectProjectWorkflow, WORKFLOW_RESOURCE } from "../src/project-workflow.mjs";
import { searchLocal } from "../src/search.mjs";
import { createSkillDraft, previewSkillDraft, skillDraftTarget } from "../src/skill-draft.mjs";
import { createSubagentDashboard } from "../src/subagent-dashboard.mjs";
import { SUBAGENT_STATUS_EVENT } from "../src/subagent-status.mjs";
import { SessionSubagents, SUBAGENT_START_RESOURCE } from "../src/subagents.mjs";
import {
  formatGitSetupPreview, formatGitSetupVerification, formatSetupPreview, formatSetupVerification,
  previewGitSetup, previewGitUpdateSetup, previewLocalSetup, verifyGitSetup, verifyLocalSetup,
} from "../src/setup-preview.mjs";
import { inspectThemeSelection, PIFY_THEME, rollbackPifyTheme, selectPifyTheme, THEME_SETTING_RESOURCE } from "../src/theme-selection.mjs";

const execFileAsync = promisify(execFile);

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
  let pendingEdit = null;
  let pendingCommit = null;
  const sessionJobs = () => jobs ??= new SessionJobs();
  let subagents = null;
  const sessionSubagents = () => {
    if (!subagents) {
      subagents = new SessionSubagents({ onStatus: (snapshot) => pi.events.emit(SUBAGENT_STATUS_EVENT, snapshot) });
      pi.events.emit(SUBAGENT_STATUS_EVENT, subagents.status());
    }
    return subagents;
  };

  pi.registerTool({
    name: "pify_commit_preview",
    label: "Pify commit preview",
    description: "Preview 1 to 8 ordered Conventional Commit groups over exact repository files. Shows complete before/after text without staging or committing. A human creates the reviewed commits with /pify-commit apply <reviewCode>. Never pushes.",
    promptSnippet: "Preview grouped Git commits without staging, committing, or pushing",
    parameters: Type.Object({ groups: Type.Array(Type.Object({
      message: Type.String(),
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 24 }),
    }), { minItems: 1, maxItems: 8 }) }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const report = await previewAtomicCommits({ cwd: ctx.cwd, groups: params.groups });
      pendingCommit = { cwd: ctx.cwd, groups: params.groups, reviewCode: report.reviewCode };
      return { content: [{ type: "text", text: JSON.stringify(report) }], details: report };
    },
  });

  pi.registerTool({
    name: "pify_edit_preview",
    label: "Pify edit preview",
    description: "Preview an exact text replacement across 1 to 12 named workspace files. Returns complete before/after content and a review code. Never writes. The user applies a reviewed preview with /pify-edit apply <reviewCode>.",
    promptSnippet: "Preview a reviewed exact-text replacement across named files without writing",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 12 }),
      find: Type.String(),
      replace: Type.String(),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const report = await previewEdit({ cwd: ctx.cwd, ...params, permission: currentPermission() });
      pendingEdit = { cwd: ctx.cwd, ...params, reviewCode: report.reviewCode };
      return { content: [{ type: "text", text: JSON.stringify(report) }], details: report };
    },
  });

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

  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const decision = authorizeShellAction({ permission: currentPermission() });
    if (decision.outcome !== "allowed") return { block: true, reason: JSON.stringify(decision) };
  });
  pi.on("user_bash", () => {
    const decision = authorizeShellAction({ permission: currentPermission() });
    if (decision.outcome !== "allowed") return {
      result: { output: JSON.stringify(decision), exitCode: 126, cancelled: false, truncated: false },
    };
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
    pendingEdit = null;
    pendingCommit = null;
    if (subagents) {
      await subagents.shutdown();
      subagents = null;
    }
    if (jobs) {
      await jobs.shutdown();
      jobs = null;
    }
    ctx.ui.setStatus("pify", undefined);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const snapshot = await buildPreferenceSnapshot({ agentDir: agentDir(), projectDir: ctx.cwd });
      if (snapshot.text) event.systemPromptOptions.sections.pify_memory = snapshot.text;
      else delete event.systemPromptOptions.sections.pify_memory;
      if (ctx.mode === "tui" && snapshot.inactive.length) {
        ctx.ui.notify(`Pify memory: ${snapshot.inactive.length} approval(s) inactive; run /pify-memory snapshot`, "warning");
      }
      if (ctx.mode === "tui" && snapshot.status === "unavailable") {
        ctx.ui.notify("Pify memory vault unavailable; no preferences applied", "warning");
      }
    } catch (error) {
      delete event.systemPromptOptions.sections.pify_memory;
      ctx.ui.notify(`Pify memory unavailable: ${error.message}`, "warning");
    }
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
          if (ctx.mode === "tui" && permission.mode !== "safe") {
            const approved = await ctx.ui.confirm("Start background job?", `Run in ${ctx.cwd}: ${command}`);
            if (!approved) {
              ctx.ui.notify("Job not started", "info");
              return;
            }
            permission = permissionContext({ ...permission, authorizedPaths: [...permission.authorizedPaths, JOB_START_RESOURCE] });
          }
          const started = await manager.start({ command, cwd: ctx.cwd, permission });
          result = started.outcome ? { status: "not_started", permission: started } : started;
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

  pi.registerCommand("pify-conflict", {
    description: "List, preview, or resolve one text Git conflict without committing or pushing",
    handler: async (args, ctx) => {
      try {
        const command = args.trim() || "list";
        if (command === "list") {
          const report = await listGitConflicts({ cwd: ctx.cwd });
          ctx.ui.notify(JSON.stringify(report), "info");
          return;
        }
        const match = /^(preview|resolve)\s+(.+?)\s+\|\s+(ours|theirs)$/.exec(command);
        if (!match) throw new Error("Usage: /pify-conflict <list|preview <file> | ours|theirs|resolve <file> | ours|theirs>");
        const [, action, file, choice] = match;
        const preview = await previewGitConflict({ cwd: ctx.cwd, file, choice });
        if (action === "preview" || preview.status !== "ready") {
          ctx.ui.notify(ctx.mode === "tui" && preview.status === "ready"
            ? `${preview.path}: ${preview.hunks} conflict hunk(s), ${choice} selected. Project tests not run.\n${preview.diff}`
            : JSON.stringify(preview), preview.status === "ready" ? "info" : "warning");
          return;
        }
        let permission = currentPermission();
        if (ctx.mode === "tui") {
          const approved = await ctx.ui.confirm("Stage this Git conflict resolution?",
            `${preview.path}: choose ${choice} in ${preview.hunks} hunk(s).\n${preview.diff}\nStructural checks passed. Project tests not run. No commit or push.`);
          if (!approved) { ctx.ui.notify("Git conflict unchanged", "info"); return; }
          const target = `git/conflicts/${preview.path}`;
          permission = permissionContext({ ...permission, authorizedPaths: [...permission.authorizedPaths, target] });
        }
        const result = await resolveGitConflict({ cwd: ctx.cwd, file, choice, permission, reviewCode: preview.reviewCode });
        ctx.ui.notify(JSON.stringify(result), result.status === "resolved" ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(JSON.stringify({ schema: "pify.git-conflict/v1", status: "error", message: error.message }), "warning");
      }
    },
  });

  pi.registerCommand("pify-edit", {
    description: "Preview or apply a reviewed exact-text replacement across named workspace files",
    handler: async (args, ctx) => {
      try {
        const command = args.trim();
        if (command.startsWith("preview ")) {
          const parts = command.slice(8).split("|").map((part) => part.trim());
          if (parts.length !== 3 || !parts[0] || !parts[2]) throw new Error("Usage: /pify-edit preview <find> | <replace> | <comma-separated relative files>");
          const input = { cwd: ctx.cwd, find: parts[0], replace: parts[1], paths: parts[2].split(",").map((part) => part.trim()) };
          const report = await previewEdit({ ...input, permission: currentPermission() });
          pendingEdit = { ...input, reviewCode: report.reviewCode };
          ctx.ui.notify(JSON.stringify(report), "info");
          return;
        }
        const match = /^apply ([0-9a-f]{20})$/.exec(command);
        if (!match) throw new Error("Usage: /pify-edit <preview <find> | <replace> | <files>|apply <reviewCode>>");
        if (!pendingEdit || pendingEdit.cwd !== ctx.cwd || pendingEdit.reviewCode !== match[1]) {
          ctx.ui.notify(JSON.stringify({ schema: "pify.edit-preview/v1", status: "stale_preview" }), "warning");
          return;
        }
        const input = pendingEdit;
        pendingEdit = null;
        let report;
        try { report = await previewEdit({ ...input, permission: currentPermission() }); }
        catch {
          ctx.ui.notify(JSON.stringify({ schema: "pify.edit-preview/v1", status: "stale_preview" }), "warning");
          return;
        }
        if (report.reviewCode !== match[1]) {
          ctx.ui.notify(JSON.stringify({ schema: "pify.edit-preview/v1", status: "stale_preview" }), "warning");
          return;
        }
        if (ctx.mode === "tui") {
          ctx.ui.notify(JSON.stringify(report), "info");
          const chosen = await ctx.ui.select(
            `Apply ${report.risk} edit to ${report.files.length} file(s)? Review code: ${match[1]}. Read the complete preview above.`,
            ["Decline", "Apply"]);
          if (chosen !== "Apply") {
            ctx.ui.notify(JSON.stringify({ schema: "pify.edit-preview/v1", status: "declined", reviewCode: match[1] }), "info");
            return;
          }
        }
        let permission = currentPermission();
        if (ctx.mode === "tui" && permission.mode !== "safe") {
          permission = permissionContext({ ...permission, authorizedPaths: [...permission.authorizedPaths, ...input.paths] });
        }
        const result = await applyEdit({ ...input, approved: true, permission });
        ctx.ui.notify(JSON.stringify(result), result.status === "applied" ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(JSON.stringify({ schema: "pify.edit-preview/v1", status: "error", message: error.message }), "warning");
      }
    },
  });

  pi.registerCommand("pify-commit", {
    description: "Preview or create explicitly approved, grouped Conventional Commits without pushing",
    handler: async (args, ctx) => {
      try {
        const command = args.trim();
        if (command.startsWith("preview ")) {
          const groups = JSON.parse(command.slice(8));
          const report = await previewAtomicCommits({ cwd: ctx.cwd, groups });
          pendingCommit = { cwd: ctx.cwd, groups, reviewCode: report.reviewCode };
          ctx.ui.notify(JSON.stringify(report), "info");
          return;
        }
        const match = /^apply ([0-9a-f]{20})$/.exec(command);
        if (!match) throw new Error("Usage: /pify-commit <preview <JSON groups>|apply <reviewCode>>");
        if (!pendingCommit || pendingCommit.cwd !== ctx.cwd || pendingCommit.reviewCode !== match[1]) {
          ctx.ui.notify(JSON.stringify({ schema: "pify.atomic-commits/v1", status: "stale_preview" }), "warning");
          return;
        }
        const input = pendingCommit;
        pendingCommit = null;
        let report;
        try { report = await previewAtomicCommits(input); }
        catch {
          ctx.ui.notify(JSON.stringify({ schema: "pify.atomic-commits/v1", status: "stale_preview" }), "warning");
          return;
        }
        if (report.reviewCode !== match[1]) {
          ctx.ui.notify(JSON.stringify({ schema: "pify.atomic-commits/v1", status: "stale_preview" }), "warning");
          return;
        }
        if (ctx.mode === "tui") {
          ctx.ui.notify(JSON.stringify(report), "info");
          const selected = await ctx.ui.select(
            `Create ${report.groups.length} commit(s) on ${report.branch}? Review code: ${match[1]}. No push. Read the full preview above.`,
            ["Decline", "Create commits"]);
          if (selected !== "Create commits") {
            ctx.ui.notify(JSON.stringify({ schema: "pify.atomic-commits/v1", status: "declined", commits: [], pushed: false }), "info");
            return;
          }
        }
        let permission = currentPermission();
        if (ctx.mode === "tui" && permission.mode !== "safe") {
          const targets = report.groups.flatMap((group) => group.files.map((file) => `git/commits/${file.path}`));
          permission = permissionContext({ ...permission, authorizedPaths: [...permission.authorizedPaths, ...targets] });
        }
        const result = await applyAtomicCommits({ ...input, approved: true, permission });
        ctx.ui.notify(JSON.stringify(result), result.status === "committed" ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(JSON.stringify({ schema: "pify.atomic-commits/v1", status: "error", message: error.message }), "warning");
      }
    },
  });

  if (process.env.PIFY_SUBAGENT_CHILD !== "1") pi.registerCommand("pify-delegate", {
    description: "Start, monitor, inspect, or cancel session-bound Pi subagents",
    handler: async (args, ctx) => {
      try {
        let command = args.trim();
        if (!command && ctx.mode === "tui") {
          const selected = await ctx.ui.select("Pify subagents", ["Start task", "Dashboard", "Status feed", "List tasks", "Inspect task", "Cancel task"]);
          if (!selected) return;
          if (selected === "Start task") {
            const task = await ctx.ui.input("Task for the subagent", "");
            if (!task) return;
            command = `start ${task.trim()}`;
          } else if (selected === "Dashboard") command = "dashboard";
          else if (selected === "Status feed") command = "status";
          else if (selected === "List tasks") command = "list";
          else {
            const id = await ctx.ui.input("Subagent ID", "");
            if (!id) return;
            command = `${selected === "Inspect task" ? "inspect" : "cancel"} ${id.trim()}`;
          }
        }
        let result;
        if (command.startsWith("start ")) {
          const payload = command.slice("start ".length);
          const separator = payload.indexOf("|");
          const task = (separator === -1 ? payload : payload.slice(0, separator)).trim();
          const scopeText = separator === -1 ? null : payload.slice(separator + 1).trim();
          if (!task || (scopeText !== null && scopeText.includes("|"))) throw new Error("Usage: /pify-delegate start <task> [| <comma-separated narrower scopes>]");
          const parent = currentPermission();
          const workerScope = scopeText === null ? undefined : scopeText ? scopeText.split(",").map((item) => item.trim()).filter(Boolean) : [];
          if (!ctx.model) {
            ctx.ui.notify(JSON.stringify(clarificationResult({ permission: parent, question: "Select a model before starting a subagent" })), "warning");
            return;
          }
          let startPermission = parent;
          if (ctx.mode === "tui") {
            const approved = await ctx.ui.confirm("Start a Pi subagent?",
              `Provider: ${ctx.model.provider}\nModel: ${ctx.model.id}\nTask: ${task}\nWorker Pify scopes: ${(workerScope ?? parent.authorizedPaths).join(", ") || "none"}`);
            if (!approved) { ctx.ui.notify("Subagent not started", "info"); return; }
            startPermission = permissionContext({ ...parent, authorizedPaths: [...parent.authorizedPaths, SUBAGENT_START_RESOURCE] });
          }
          result = sessionSubagents().start({ task, cwd: ctx.cwd, provider: ctx.model.provider, model: ctx.model.id,
            thinkingLevel: ctx.thinkingLevel, parentPermission: parent, startPermission, workerScope,
            parentTools: pi.getActiveTools(), trusted: ctx.isProjectTrusted() });
        } else if (command === "dashboard" && ctx.mode === "tui") {
          let dashboard;
          try {
            await ctx.ui.custom((tui, theme, keybindings, done) => {
              dashboard = createSubagentDashboard({ manager: sessionSubagents(), tui, theme, keybindings, done });
              return dashboard;
            });
          } finally { dashboard?.dispose(); }
          return;
        } else if (command === "dashboard" || command === "status") result = sessionSubagents().status();
        else if (command === "list") result = sessionSubagents().list();
        else if (command.startsWith("inspect ")) result = sessionSubagents().inspect(command.slice("inspect ".length).trim());
        else if (command.startsWith("cancel ")) result = await sessionSubagents().cancel(command.slice("cancel ".length).trim());
        else throw new Error("Usage: /pify-delegate <start task [| narrower scopes]|dashboard|status|list|inspect id|cancel id>");
        ctx.ui.notify(JSON.stringify(result), result.outcome && result.outcome !== "allowed" ? "warning" : "info");
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
      const action = { kind: target === SHELL_COMMAND_RESOURCE ? "execute-shell" :
        target === JOB_START_RESOURCE ? "start-job" : "adopt", targets: target ? [target] : [] };
      const result = target === SHELL_COMMAND_RESOURCE || target === JOB_START_RESOURCE
        ? authorizeShellAction({ permission, action }) : authorizePifyAction({ permission, action });
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

  pi.registerCommand("pify-memory", {
    description: "Set up, review, approve, sync, and draft skills from private memory",
    handler: async (args, ctx) => {
      try {
        let command = args.trim();
        if (!command && ctx.mode !== "tui") {
          ctx.ui.notify(JSON.stringify(await requestChoice({
            question: "Choose memory setup action and an absolute path when needed",
            options: ["status", "create <absolute path>", "connect <absolute path>", "skip", "review <note>", "approve <note> <review-code>", "revoke <note>", "snapshot"],
            permission: currentPermission(),
          })), "warning");
          return;
        }
        if (!command) {
          const selected = await ctx.ui.select("Pify memory", ["Status", "Create new vault", "Connect existing vault", "Skip memory", "Review note", "Approve note", "Revoke note", "Snapshot", "Push notes", "Pull notes", "Draft skill"]);
          if (!selected) return;
          const action = { Status: "status", "Create new vault": "create", "Connect existing vault": "connect", "Skip memory": "skip", "Review note": "review", "Approve note": "approve", "Revoke note": "revoke", Snapshot: "snapshot", "Push notes": "push", "Pull notes": "pull", "Draft skill": "draft" }[selected];
          if (["create", "connect", "review", "approve", "revoke"].includes(action)) {
            const entered = await ctx.ui.input(action === "create" || action === "connect" ? "Absolute vault path" : "Vault-relative Markdown note path",
              action === "create" ? path.join(os.homedir(), "pify-memory") : "");
            if (!entered) return;
            command = `${action} ${entered.trim()}`;
          } else if (action === "draft") {
            const note = await ctx.ui.input("Approved procedure path in the vault", "03-reference/procedures/");
            if (!note) return;
            const destination = await ctx.ui.input("Absolute new draft skill directory", path.join(ctx.cwd, ".pi", "skills", "my-procedure"));
            if (!destination) return;
            command = `draft ${note.trim()} | ${destination.trim()}`;
          } else command = action;
        }
        if (command === "status") {
          const result = await inspectMemoryVault({ agentDir: agentDir() });
          ctx.ui.notify(ctx.mode === "tui" ? `Memory vault: ${result.status}${result.path ? ` (${result.path})` : ""}${result.reason ? `: ${result.reason}` : ""}` : JSON.stringify(result), "info");
          return;
        }
        if (command === "snapshot") {
          const { text: _text, ...snapshot } = await buildPreferenceSnapshot({ agentDir: agentDir(), projectDir: ctx.cwd });
          ctx.ui.notify(ctx.mode === "tui" ? `Memory preferences: ${snapshot.entries.length} active, ${snapshot.inactive.length} inactive (${snapshot.status})` : JSON.stringify(snapshot), "info");
          return;
        }
        if (command === "push-preview" || /^push(?:\s+[a-f0-9]{64})?$/.test(command)) {
          const plan = await previewMemoryPush({ agentDir: agentDir() });
          if (command === "push-preview") {
            ctx.ui.notify(ctx.mode === "tui"
              ? `Memory push: ${plan.changes.length} note(s), ${plan.excluded.length} excluded\n${plan.changes.map((item) => `${item.action}: ${item.relativePath}`).join("\n")}\nReview code: ${plan.reviewCode}`
              : JSON.stringify(plan), "info");
            return;
          }
          let reviewCode = /^push\s+([a-f0-9]{64})$/.exec(command)?.[1];
          let permission = currentPermission();
          if (ctx.mode === "tui") {
            const approved = await ctx.ui.confirm("Push memory notes to a private PR?",
              `${plan.repo}\n${plan.changes.map((item) => `${item.action}: ${item.relativePath}`).join("\n") || "No new note changes"}\n${plan.excluded.length} other file(s) excluded. PR merge stays manual.`);
            if (!approved) { ctx.ui.notify("Memory push cancelled", "info"); return; }
            reviewCode ??= plan.reviewCode;
            permission = permissionContext({ ...permission, authorizedPaths: [
              ...permission.authorizedPaths, memorySyncTarget(plan.vaultPath, "push"),
            ] });
          } else if (!reviewCode) {
            ctx.ui.notify(JSON.stringify(clarificationResult({ permission, question: "Run push-preview and supply its review code before pushing" })), "warning");
            return;
          }
          const result = await pushMemory({ agentDir: agentDir(), reviewCode, permission });
          ctx.ui.notify(JSON.stringify(result), result.outcome && result.outcome !== "allowed" ? "warning" : "info");
          return;
        }
        if (command === "pull") {
          let permission = currentPermission();
          if (ctx.mode === "tui") {
            const selection = await inspectMemoryVault({ agentDir: agentDir() });
            if (selection.status !== "available") throw new Error(`Memory vault is ${selection.status}`);
            const approved = await ctx.ui.confirm("Pull private memory main?",
              `Fast-forward ${selection.path}. Pulled notes remain inactive until approved on this machine.`);
            if (!approved) { ctx.ui.notify("Memory pull cancelled", "info"); return; }
            permission = permissionContext({ ...permission, authorizedPaths: [
              ...permission.authorizedPaths, memorySyncTarget(selection.path, "pull"),
            ] });
          }
          const result = await pullMemory({ agentDir: agentDir(), permission });
          ctx.ui.notify(JSON.stringify(result), result.outcome && result.outcome !== "allowed" ? "warning" : "info");
          return;
        }
        if (command.startsWith("draft-preview ") || command.startsWith("draft ")) {
          const previewOnly = command.startsWith("draft-preview ");
          const fields = command.slice(previewOnly ? "draft-preview ".length : "draft ".length).split("|").map((item) => item.trim());
          if (fields.length < 2 || fields.length > (previewOnly ? 2 : 3) || !fields[0] || !fields[1]) {
            throw new Error("Usage: /pify-memory draft-preview <procedure> | <absolute directory>, or draft <procedure> | <absolute directory> | <review-code>");
          }
          const preview = await previewSkillDraft({ agentDir: agentDir(), relativePath: fields[0], destinationDir: fields[1] });
          if (previewOnly) {
            ctx.ui.notify(ctx.mode === "tui"
              ? `Inactive skill draft: ${preview.draftPath}\n${preview.content}\nReview code: ${preview.reviewCode}`
              : JSON.stringify(preview), "info");
            return;
          }
          let reviewCode = fields[2];
          let permission = currentPermission();
          if (ctx.mode === "tui") {
            const approved = await ctx.ui.confirm("Create inactive skill draft?",
              `Source: ${preview.relativePath}\nDestination: ${preview.draftPath}\nReview before activation or publication.\n\n${preview.content}`);
            if (!approved) { ctx.ui.notify("Skill draft unchanged", "info"); return; }
            reviewCode ??= preview.reviewCode;
            permission = permissionContext({ ...permission, authorizedPaths: [
              ...permission.authorizedPaths, skillDraftTarget(preview.vaultPath, preview.relativePath, preview.directory),
            ] });
          } else if (!reviewCode) {
            ctx.ui.notify(JSON.stringify(clarificationResult({ permission, question: "Run draft-preview and supply its review code before creating a skill draft" })), "warning");
            return;
          }
          const result = await createSkillDraft({ agentDir: agentDir(), relativePath: fields[0], destinationDir: fields[1], reviewCode, permission });
          ctx.ui.notify(JSON.stringify(result), result.outcome && result.outcome !== "allowed" ? "warning" : "info");
          return;
        }
        const review = /^review\s+(.+)$/.exec(command);
        if (review) {
          const preview = await previewMemoryNote({ agentDir: agentDir(), relativePath: review[1], projectDir: ctx.cwd });
          ctx.ui.notify(ctx.mode === "tui"
            ? `Review ${preview.relativePath} (${preview.scope}${preview.projectPath ? `: ${preview.projectPath}` : ""})\n${preview.content}\nReview code: ${preview.reviewCode}`
            : JSON.stringify(preview), "info");
          return;
        }
        const approve = /^approve\s+(.+?)(?:\s+([a-f0-9]{64}))?$/.exec(command);
        if (approve) {
          let reviewCode = approve[2];
          let permission = currentPermission();
          if (ctx.mode === "tui") {
            const preview = await previewMemoryNote({ agentDir: agentDir(), relativePath: approve[1], projectDir: ctx.cwd });
            if (preview.scope === "inactive") throw new Error("Move this note to global preferences or project context before approval");
            const approved = await ctx.ui.confirm("Approve memory note?",
              `Note: ${preview.relativePath}\nScope: ${preview.scope}${preview.projectPath ? ` (${preview.projectPath})` : ""}\n${preview.scope === "procedure" ? "Procedure approval permits a later draft; it does not add text to the model prompt." : "Approved text may be sent to the selected model provider on each run."}\n\n${preview.content}`);
            if (!approved) { ctx.ui.notify("Memory approval unchanged", "info"); return; }
            reviewCode ??= preview.reviewCode;
            permission = permissionContext({ ...permission, authorizedPaths: [
              ...permission.authorizedPaths, memoryApprovalTarget(preview.vaultPath, approve[1]),
            ] });
          } else if (!reviewCode) {
            ctx.ui.notify(JSON.stringify(clarificationResult({ permission, question: "Review code required before approving this note" })), "warning");
            return;
          }
          const result = await approveMemoryNote({ agentDir: agentDir(), relativePath: approve[1], projectDir: ctx.cwd, reviewCode, permission });
          ctx.ui.notify(ctx.mode === "tui" ? `Memory note: ${result.status ?? result.outcome}` : JSON.stringify(result), result.outcome && result.outcome !== "allowed" ? "warning" : "info");
          return;
        }
        const revoke = /^revoke\s+(.+)$/.exec(command);
        if (revoke) {
          let permission = currentPermission();
          if (ctx.mode === "tui") {
            const selection = await inspectMemoryVault({ agentDir: agentDir() });
            if (!selection.path) throw new Error("No vault is selected");
            const approved = await ctx.ui.confirm("Revoke memory approval?", `Stop applying ${revoke[1]} and keep its file?`);
            if (!approved) { ctx.ui.notify("Memory approval unchanged", "info"); return; }
            permission = permissionContext({ ...permission, authorizedPaths: [
              ...permission.authorizedPaths, memoryApprovalTarget(selection.path, revoke[1]),
            ] });
          }
          const result = await revokeMemoryNote({ agentDir: agentDir(), relativePath: revoke[1], permission });
          ctx.ui.notify(ctx.mode === "tui" ? `Memory note: ${result.status ?? result.outcome}` : JSON.stringify(result), result.outcome && result.outcome !== "allowed" ? "warning" : "info");
          return;
        }
        const match = /^(create|connect)\s+(.+)$/.exec(command);
        const action = command === "skip" ? "skip" : match?.[1];
        if (!action) {
          ctx.ui.notify("Usage: /pify-memory [status|create <absolute path>|connect <absolute path>|skip|review <note>|approve <note> [review-code]|revoke <note>|snapshot|push-preview|push [review-code]|pull|draft-preview <procedure> | <absolute directory>|draft <procedure> | <absolute directory> | <review-code>]", "warning");
          return;
        }
        let permission = currentPermission();
        let vaultPath = null;
        if (match) vaultPath = await resolveMemoryVaultPath(agentDir(), match[2]);
        if (ctx.mode === "tui") {
          const approved = await ctx.ui.confirm(`${action === "skip" ? "Skip" : action === "create" ? "Create" : "Connect"} memory vault?`,
            action === "skip" ? "Forget the selected vault path; keep every vault file?" :
              `${action === "create" ? "Create empty scope folders in" : "Add missing scope folders to"} ${vaultPath} and select it?`);
          if (!approved) {
            ctx.ui.notify("Memory selection unchanged", "info");
            return;
          }
          permission = permissionContext({ ...permission, authorizedPaths: [
            ...permission.authorizedPaths, ...(vaultPath ? memoryVaultTargets(vaultPath) : [MEMORY_STATE_RESOURCE]),
          ] });
        }
        const result = action === "create" ? await createMemoryVault({ agentDir: agentDir(), vaultPath, permission }) :
          action === "connect" ? await connectMemoryVault({ agentDir: agentDir(), vaultPath, permission }) :
          await skipMemoryVault({ agentDir: agentDir(), permission });
        ctx.ui.notify(ctx.mode === "tui" ? `Memory vault: ${result.status ?? result.outcome}` : JSON.stringify(result), result.outcome && result.outcome !== "allowed" ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(ctx.mode === "tui" ? `Pify memory: ${error.message}` : JSON.stringify({ status: "conflict", reason: error.message }), "warning");
      }
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
    description: "Inspect, enable, or disable Pify's development workflow for this project",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (!action || action === "status") {
        const status = await inspectProjectWorkflow({ projectDir: ctx.cwd, agentDir: agentDir() });
        ctx.ui.notify(ctx.mode === "tui" ? `Project workflow: ${status.status}` : JSON.stringify(status), "info");
        return;
      }
      if (action !== "enable" && action !== "disable") {
        ctx.ui.notify("Usage: /pify-workflow [status|enable|disable]", "warning");
        return;
      }
      let permission = currentPermission();
      if (ctx.mode === "tui") {
        const approved = await ctx.ui.confirm(`${action === "enable" ? "Enable" : "Disable"} project workflow?`,
          action === "enable" ? `Create or restore .pi/${WORKFLOW_RESOURCE} in ${ctx.cwd}?` :
            `Rename .pi/${WORKFLOW_RESOURCE} to SKILL.pify-disabled.md in ${ctx.cwd}; keep every project file?`);
        if (!approved) {
          ctx.ui.notify("Project workflow unchanged", "info");
          return;
        }
        permission = permissionContext({ ...permission, authorizedPaths: [...permission.authorizedPaths, WORKFLOW_RESOURCE] });
      }
      try {
        const result = action === "enable"
          ? await enableProjectWorkflow({ projectDir: ctx.cwd, agentDir: agentDir(), permission })
          : await disableProjectWorkflow({ projectDir: ctx.cwd, agentDir: agentDir(), permission });
        const message = ["enabled", "disabled"].includes(result.status) ? { ...result, next: "Run /reload to refresh project skills" } : result;
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
