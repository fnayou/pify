const VISIBLE_JOBS = 8;
const VISIBLE_DETAIL_LINES = 12;

function safeLines(value) {
  return String(value ?? "").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, " ").replace(/\r/g, "").split("\n");
}

function clip(value, width) {
  let result = "";
  let columns = 0;
  for (const glyph of new Intl.Segmenter().segment(String(value))) {
    const character = glyph.segment;
    const point = character.codePointAt(0);
    const wide = point >= 0x1100 && (point <= 0x115f || point >= 0x2329 && point <= 0x232a ||
      point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3 ||
      point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe19 ||
      point >= 0xfe30 && point <= 0xfe6f || point >= 0xff00 && point <= 0xff60 ||
      point >= 0xffe0 && point <= 0xffe6 || point >= 0x1f300 && point <= 0x1faff);
    const cells = wide ? 2 : 1;
    if (columns + cells > Math.max(1, width)) break;
    result += character;
    columns += cells;
  }
  return result;
}

function duration(milliseconds) {
  const seconds = Math.max(0, milliseconds) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

/** Live Pi TUI component backed only by the stable subagent status API. */
export function createSubagentDashboard({ manager, tui, theme, keybindings, done, intervalMs = 1000 }) {
  let selected = 0;
  let detail = false;
  let scroll = 0;
  let disposed = false;
  const unsubscribe = manager.subscribe(() => tui.requestRender());
  const timer = setInterval(() => tui.requestRender(), intervalMs);

  const component = {
    render(width) {
      const status = manager.status();
      const jobs = status.jobs;
      selected = Math.max(0, Math.min(selected, jobs.length - 1));
      const current = jobs[selected];
      if (detail && current) {
        const inspected = manager.inspect(current.id);
        const lines = [
          `Pify subagent ${current.id}`,
          `State: ${current.state}    Elapsed: ${duration(current.elapsedMs)}    Provider: ${current.provider}`,
          `Model: ${current.model}`,
          ...safeLines(`Task: ${inspected.task}`),
          `Activity: ${current.activity || "none"}`,
          ...safeLines(`Error: ${current.error ?? (current.cancelled ? inspected.message ?? "cancelled" : "none")}`),
          "Result:",
          ...safeLines(inspected.output || "(no result yet)"),
          "Diagnostics:",
          ...safeLines(inspected.stderr || "(none)"),
        ];
        scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - VISIBLE_DETAIL_LINES)));
        return [
          theme.fg("accent", clip("Pify subagent details", width)),
          ...lines.slice(scroll, scroll + VISIBLE_DETAIL_LINES).map((line) => clip(line, width)),
          theme.fg("dim", clip(`Lines ${scroll + 1}-${Math.min(lines.length, scroll + VISIBLE_DETAIL_LINES)}/${lines.length} · j/k scroll · Esc back`, width)),
        ];
      }

      const { counts } = status;
      const heading = `Pify subagents  active ${counts.active}  queued ${counts.queued}  done ${counts.succeeded + counts.failed + counts.cancelled + counts.timedOut}`;
      const first = Math.max(0, Math.min(selected - 3, Math.max(0, jobs.length - VISIBLE_JOBS)));
      const visible = jobs.slice(first, first + VISIBLE_JOBS);
      const rows = visible.map((job, index) => {
        const marker = first + index === selected ? ">" : " ";
        const summary = job.error ?? (job.cancelled ? "Cancelled" : job.activity);
        return clip(`${marker} ${job.id.slice(0, 8)}  ${job.state.padEnd(10)}  ${duration(job.elapsedMs).padStart(7)}  ${job.provider}  ${job.task}${summary ? ` · ${summary}` : ""}`, width);
      });
      return [
        theme.fg("accent", clip(heading, width)),
        clip("  ID        STATE          TIME     PROVIDER  TASK / ACTIVITY", width),
        ...(rows.length ? rows : [clip("  No subagents in this session", width)]),
        theme.fg("dim", clip(`${jobs.length ? `Showing ${first + 1}-${first + visible.length}/${jobs.length} · ` : ""}j/k select · Enter inspect · Esc close`, width)),
      ];
    },
    handleInput(data) {
      if (keybindings.matches(data, "tui.select.cancel")) {
        if (detail) { detail = false; scroll = 0; tui.requestRender(); }
        else done();
        return;
      }
      if (keybindings.matches(data, "tui.select.confirm")) {
        if (!detail && manager.status().jobs.length) { detail = true; scroll = 0; tui.requestRender(); }
        return;
      }
      const delta = data === "j" || data === "\x1b[B" ? 1 : data === "k" || data === "\x1b[A" ? -1 : 0;
      if (!delta) return;
      if (detail) scroll = Math.max(0, scroll + delta);
      else selected = Math.max(0, Math.min(selected + delta, manager.status().jobs.length - 1));
      tui.requestRender();
    },
    invalidate() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
  return component;
}
