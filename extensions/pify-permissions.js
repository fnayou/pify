import { authorizePifyAction, modeLabel, permissionContext } from "../src/permissions.mjs";

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
}
