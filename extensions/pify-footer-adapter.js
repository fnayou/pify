import { attachSubagentFooterAdapter } from "../src/footer-adapter.mjs";

/** Load explicitly with Pi's -e flag; the Pify package does not declare this adapter. */
export default function (pi) {
  let dispose = null;
  pi.on("session_start", (_event, ctx) => {
    dispose?.();
    dispose = ctx.mode === "tui"
      ? attachSubagentFooterAdapter({ events: pi.events, setStatus: (key, value) => ctx.ui.setStatus(key, value) })
      : null;
  });
  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = null;
  });
}
