import {
  digestFile,
  inspectManagedFile,
  listOwnedFiles,
  prepareManagedFileChange,
  promoteManagedFileChange,
  rollbackManagedFileChange,
} from "./managed-state.mjs";

function bytesFor(content) {
  if (typeof content === "string") return Buffer.from(content);
  if (Buffer.isBuffer(content)) return content;
  throw new Error("Managed file content must be a string or Buffer");
}

function samePlan(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Inspect every exact destination without creating Pify state or modifying Pi files. */
export async function previewAdoption({ agentDir, resources }) {
  if (!Array.isArray(resources) || resources.length === 0) throw new Error("At least one resource is required");
  const seen = new Set();
  const changes = [];
  for (const resource of resources) {
    const inspected = await inspectManagedFile({ agentDir, relativePath: resource.relativePath });
    if (seen.has(inspected.relativePath)) throw new Error(`Duplicate resource: ${inspected.relativePath}`);
    seen.add(inspected.relativePath);
    changes.push({
      relativePath: inspected.relativePath,
      action: inspected.action,
      reason: inspected.reason,
      oldDigest: inspected.oldDigest,
      oldMode: inspected.mode ?? null,
      newDigest: digestFile(bytesFor(resource.content)),
      parentsToCreate: inspected.parentsToCreate ?? [],
    });
  }
  return { schemaVersion: 1, changes };
}

/** Apply a previously reviewed preview. Unowned files require exact opt-in. */
export async function applyAdoption({ agentDir, resources, preview, approvedConflicts = [], onApplied }) {
  if (!preview || preview.schemaVersion !== 1 || !Array.isArray(preview.changes)) throw new Error("A reviewed preview is required");
  if (!Array.isArray(approvedConflicts)) throw new Error("Conflict approvals must be an array");
  const current = await previewAdoption({ agentDir, resources });
  if (!samePlan(preview, current)) throw new Error("Resource plan changed after preview");
  const approvals = new Set(approvedConflicts);
  if (approvals.size !== approvedConflicts.length) throw new Error("Duplicate conflict approval");
  for (const change of current.changes) {
    if (change.action === "conflict" && (change.reason !== "unowned" || !approvals.has(change.relativePath))) {
      throw new Error(`Unresolved resource conflict: ${change.relativePath}: ${change.reason}`);
    }
    approvals.delete(change.relativePath);
  }
  if (approvals.size) throw new Error("Conflict approval does not match the preview");

  const transactions = [];
  try {
    for (let index = 0; index < resources.length; index += 1) {
      const resource = resources[index];
      const change = current.changes[index];
      const prepared = await prepareManagedFileChange({
        agentDir,
        relativePath: change.relativePath,
        expectedNewDigest: change.newDigest,
        expectedOldDigest: change.oldDigest,
        expectedOldMode: change.oldMode,
        adoptExisting: change.action === "conflict",
      });
      transactions.push(prepared.id);
      await promoteManagedFileChange({ agentDir, transactionId: prepared.id, content: bytesFor(resource.content) });
      if (onApplied) await onApplied({ relativePath: change.relativePath, transactionId: prepared.id });
    }
    return { status: "applied", transactions };
  } catch (error) {
    const recovery = await rollbackAdoption({ agentDir, transactions });
    const failure = new Error(`Adoption failed: ${error.message}; rollback ${recovery.status}`, { cause: error });
    failure.recovery = recovery;
    throw failure;
  }
}

/** Reverse an unwanted or failed operation in reverse order. Conflicts stay untouched. */
export async function rollbackAdoption({ agentDir, transactions }) {
  const results = [];
  for (const transactionId of [...transactions].reverse()) {
    try {
      results.push({ transactionId, ...(await rollbackManagedFileChange({ agentDir, transactionId })) });
    } catch (error) {
      results.push({ transactionId, status: "recovery-needed", reason: error.message });
    }
  }
  return { status: results.some((result) => result.status === "recovery-needed") ? "recovery-needed" : "rolled-back", results };
}

/** Show each provenance-matched file that uninstall can remove or restore. */
export async function previewUninstall({ agentDir }) {
  return { schemaVersion: 1, changes: await listOwnedFiles({ agentDir }) };
}

/** Unwind each intact ownership chain; preserve drifted and unowned paths. */
export async function uninstallManagedFiles({ agentDir, preview }) {
  if (!preview || preview.schemaVersion !== 1 || !Array.isArray(preview.changes)) throw new Error("A reviewed uninstall preview is required");
  const current = await previewUninstall({ agentDir });
  if (!samePlan(preview, current)) throw new Error("Uninstall plan changed after preview");
  const results = [];
  for (const change of [...current.changes].reverse()) {
    if (change.action === "conflict") {
      results.push({ relativePath: change.relativePath, status: "preserved", reason: change.reason });
      continue;
    }
    try {
      let transactionId = change.lastTransactionId;
      const seen = new Set();
      while (transactionId) {
        if (seen.has(transactionId)) throw new Error("Ownership transaction cycle");
        seen.add(transactionId);
        await rollbackManagedFileChange({ agentDir, transactionId });
        const remaining = (await listOwnedFiles({ agentDir })).find((item) => item.relativePath === change.relativePath);
        transactionId = remaining?.lastTransactionId ?? null;
        if (remaining && !transactionId) throw new Error("Earlier ownership has no transaction provenance");
      }
      results.push({ relativePath: change.relativePath, status: change.action === "restore" ? "restored" : "removed" });
    } catch (error) {
      results.push({ relativePath: change.relativePath, status: "recovery-needed", reason: error.message });
    }
  }
  return { status: results.some((result) => result.status === "preserved" || result.status === "recovery-needed") ? "partial" : "uninstalled", results };
}
