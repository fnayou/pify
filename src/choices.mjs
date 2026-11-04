import { clarificationResult } from "./permissions.mjs";

/** Ask for one missing detail in a terminal, or return the same request to a headless caller. */
export async function requestChoice({ question, options, permission, select }) {
  if (typeof question !== "string" || !question.trim() || question.length > 200) throw new Error("A question of at most 200 characters is required");
  if (!Array.isArray(options) || options.length < 2 || options.length > 8 ||
      options.some((option) => typeof option !== "string" || !option.trim() || option.length > 80) ||
      new Set(options).size !== options.length) throw new Error("Two to eight distinct, nonempty choices are required");
  const result = clarificationResult({ permission, question, options });
  if (!select) return result;
  const selected = await select(question, options);
  if (selected === undefined) return { ...result, reason: "Selection cancelled" };
  if (!options.includes(selected)) throw new Error("Selection was not one of the offered choices");
  return { ...result, outcome: "allowed", missing: [], selection: selected };
}
