import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildHealthReport, formatHealthReport } from "../src/health.mjs";
import { authorizePifyAction, modeLabel, permissionContext } from "../src/permissions.mjs";
import { enableProjectWorkflow, inspectProjectWorkflow, WORKFLOW_RESOURCE } from "../src/project-workflow.mjs";

const execFileAsync = promisify(execFile);

export default function (pi) {
  pi.registerFlag("pify-mode", { type: "string", default: "balanced", description: "Pify Safe, Balanced, or Full mode" });
  pi.registerFlag("pify-scope", { type: "string", default: "", description: "Comma-separated exact Pify resource paths" });

  const currentPermission = () => permissionContext({
    mode: String(pi.getFlag("pify-mode") ?? "balanced").toLowerCase(),
    authorizedPaths: String(pi.getFlag("pify-scope") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    callerId: "pi-session",
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("pify", modeLabel(currentPermission()));
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("pify", undefined);
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
      const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
      const report = await buildHealthReport({ agentDir, projectDir: ctx.cwd, piVersion });
      ctx.ui.notify(ctx.mode === "tui" ? formatHealthReport(report) : JSON.stringify(report), "info");
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
}
