import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { permissionContext } from "../src/permissions.mjs";
import { inspectThemeSelection, rollbackPifyTheme, selectPifyTheme, THEME_SETTING_RESOURCE } from "../src/theme-selection.mjs";

const permission = permissionContext({ authorizedPaths: [THEME_SETTING_RESOURCE], callerId: "fixture-user" });

async function fixture(t, settings) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pify-theme-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir);
  const settingsPath = path.join(agentDir, "settings.json");
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { agentDir, settingsPath };
}

test("fresh selection is available without modifying saved settings", async (t) => {
  const { agentDir, settingsPath } = await fixture(t, { packages: ["pify"] });
  const before = await fs.readFile(settingsPath);
  assert.deepEqual(await inspectThemeSelection({ agentDir }), { theme: null, usePifyOnFreshStart: true, rollbackAvailable: false });
  assert.deepEqual(await fs.readFile(settingsPath), before);
  await assert.rejects(fs.stat(path.join(agentDir, "pify-state")), { code: "ENOENT" });
});

test("fresh default journals the missing theme and can be rolled back", async (t) => {
  const { agentDir, settingsPath } = await fixture(t, { packages: ["pify"], footerLink: "user-footer" });
  const selected = await selectPifyTheme({ agentDir, permission, approvalSource: "fresh-default" });
  assert.equal(selected.status, "selected");
  const journal = JSON.parse(await fs.readFile(path.join(agentDir, "pify-state", "theme-selection.json"), "utf8"));
  assert.equal(journal.transactions[0].approvalSource, "fresh-default");
  assert.deepEqual(journal.transactions[0].previous, { present: false });
  assert.equal((await inspectThemeSelection({ agentDir })).rollbackAvailable, true);
  assert.equal((await rollbackPifyTheme({ agentDir, permission })).status, "rolled-back");
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, "utf8")), { packages: ["pify"], footerLink: "user-footer", theme: "system" });
  assert.equal((await inspectThemeSelection({ agentDir })).usePifyOnFreshStart, false);
});

test("fresh default refuses a saved personal theme", async (t) => {
  const { agentDir, settingsPath } = await fixture(t, { theme: "personal", footerLink: "user-footer" });
  const before = await fs.readFile(settingsPath);
  await assert.rejects(selectPifyTheme({ agentDir, permission, approvalSource: "fresh-default" }), /Fresh theme requires no saved choice/);
  assert.deepEqual(await fs.readFile(settingsPath), before);
  await assert.rejects(fs.stat(path.join(agentDir, "pify-state")), { code: "ENOENT" });
});

test("failed fresh write leaves a recoverable journal without changing settings", async (t) => {
  const { agentDir, settingsPath } = await fixture(t, { packages: ["pify"] });
  await fs.mkdir(path.join(agentDir, "pify-state"), { mode: 0o700 });
  await fs.chmod(agentDir, 0o500);
  try {
    await assert.rejects(selectPifyTheme({ agentDir, permission, approvalSource: "fresh-default" }), { code: "EACCES" });
  } finally {
    await fs.chmod(agentDir, 0o700);
  }
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(settingsPath, "utf8")), "theme"), false);
  assert.equal((await inspectThemeSelection({ agentDir })).rollbackAvailable, true);
  assert.equal((await rollbackPifyTheme({ agentDir, permission })).status, "rolled-back");
  assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).theme, "system");
});

test("approved personal theme change records prior choice and restores it without touching footer", async (t) => {
  const { agentDir, settingsPath } = await fixture(t, { packages: ["pify"], theme: "personal", footerLink: "user-footer" });
  const denied = await selectPifyTheme({ agentDir, permission: permissionContext() });
  assert.equal(denied.outcome, "clarification_required");
  assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).theme, "personal");
  const applied = await selectPifyTheme({ agentDir, permission });
  assert.equal(applied.status, "selected");
  assert.equal(applied.previousTheme, "personal");
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, "utf8")), { packages: ["pify"], theme: "pify", footerLink: "user-footer" });
  assert.equal((await fs.stat(settingsPath)).mode & 0o777, 0o600);
  const journal = JSON.parse(await fs.readFile(path.join(agentDir, "pify-state", "theme-selection.json"), "utf8"));
  assert.equal(journal.transactions[0].approvedBy, "fixture-user");
  assert.equal(journal.transactions[0].approvalSource, "explicit-scope");
  assert.deepEqual(journal.transactions[0].previous, { present: true, value: "personal" });
  assert.equal((await inspectThemeSelection({ agentDir })).rollbackAvailable, true);

  const changed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  changed.footerLink = "updated-user-footer";
  await fs.writeFile(settingsPath, `${JSON.stringify(changed)}\n`);
  assert.equal((await rollbackPifyTheme({ agentDir, permission })).status, "rolled-back");
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, "utf8")), { packages: ["pify"], theme: "personal", footerLink: "updated-user-footer" });
  assert.equal((await inspectThemeSelection({ agentDir })).rollbackAvailable, false);
});

test("theme accent and base match Pify brand data", async () => {
  const theme = JSON.parse(await fs.readFile(new URL("../themes/pify.json", import.meta.url), "utf8"));
  const brand = JSON.parse(await fs.readFile(new URL("../brand/data/brand.json", import.meta.url), "utf8"));
  assert.equal(theme.vars.accent, brand.palette.accent);
  assert.equal(theme.vars.base, brand.palette.base);
});

test("new user can persist and undo Pify choice; later personal choice is preserved", async (t) => {
  const { agentDir, settingsPath } = await fixture(t, { packages: ["pify"] });
  assert.equal((await selectPifyTheme({ agentDir, permission })).status, "selected");
  assert.equal((await selectPifyTheme({ agentDir, permission })).status, "already_selected");
  assert.equal((await rollbackPifyTheme({ agentDir, permission })).status, "rolled-back");
  assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).theme, "system");

  await selectPifyTheme({ agentDir, permission });
  const changed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  changed.theme = "personal";
  await fs.writeFile(settingsPath, `${JSON.stringify(changed)}\n`);
  await assert.rejects(rollbackPifyTheme({ agentDir, permission }), /preserving current choice/);
  assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).theme, "personal");
});

test("symlinked settings are refused without creating Pify state", async (t) => {
  const { agentDir, settingsPath } = await fixture(t, { theme: "personal" });
  const actual = path.join(agentDir, "actual.json");
  await fs.rename(settingsPath, actual);
  await fs.symlink(actual, settingsPath);
  await assert.rejects(selectPifyTheme({ agentDir, permission }), /Unsafe Pi settings/);
  await assert.rejects(fs.stat(path.join(agentDir, "pify-state")), { code: "ENOENT" });
  assert.equal(JSON.parse(await fs.readFile(actual, "utf8")).theme, "personal");
});
