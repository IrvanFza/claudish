/**
 * Plan-mode conformance rules.
 *
 * Background (measured, not assumed). Claude Code 2.1.220's ExitPlanModeV2 takes
 * NO plan parameter — its advertised schema is `{allowedPrompts?}` and the tool
 * description says outright: "This tool does NOT take the plan content as a
 * parameter - it will read the plan from the file you wrote". CC's
 * `normalizeToolInput` injects `plan` from disk at the session's assigned path.
 *
 * So `ExitPlanMode({})` is CORRECT, and the real failure is upstream: the model
 * writes its plan somewhere else. gpt-5.6-sol produced a complete 12.9 KB plan
 * under a filename it invented; CC read the assigned path, found nothing, and
 * returned `plan: null`. That downgrades the approval dialog from the rich form
 * ("Here is Claude's plan" + `Yes, and bypass permissions` / `Yes, auto-accept
 * edits` / `Yes, manually approve edits`) to a bare "Exit plan mode?" yes/no —
 * and since the rich dialog is the only surface that offers permission
 * elevation on exit, the session always falls back to manual approval.
 *
 * Across 115 recorded ExitPlanMode calls the discriminator was exact: sessions
 * that wrote to the assigned path got the rich dialog 7/7, sessions that did not
 * got the degraded one 17/17. Native Claude models were 87/87 correct, so this
 * rule is scoped to foreign models only.
 */

import type { BehaviorRule } from "../types.js";

/** Tools that can create the plan file, and so can target the wrong path. */
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];

function directoryOf(filePath: string): string | undefined {
  const slash = filePath.lastIndexOf("/");
  return slash > 0 ? filePath.slice(0, slash) : undefined;
}

/**
 * Keeps the model's plan writes pointed at the plan file Claude Code actually
 * reads, and restates the path where the model is most likely to look for it.
 */
export const planFilePathRule: BehaviorRule = {
  id: "plan-mode/plan-file-path",
  description:
    "Keep plan-mode writes on the plan file Claude Code assigned, and name that " +
    "path in the ExitPlanMode description.",
  defaultSeverity: "fix",
  interceptsTools: WRITE_TOOLS,

  // Native Claude models are already 87/87 on this; running the rule for them
  // would be pure risk with no upside.
  appliesTo: ({ isNativeAnthropic }) => !isNativeAnthropic,

  // Outside plan mode this rule cannot fire, so it must not cause Write/Edit
  // arguments to be buffered — that would suppress incremental streaming of
  // file contents on every ordinary request.
  armed: (facts) => facts.planModeActive === true,

  onRequest(ctx) {
    const { planModeActive, planFilePath } = ctx.harness;
    if (!planModeActive || !planFilePath) return [];

    // Only speak up if the tool is actually on offer this turn.
    const hasExitPlanMode =
      ctx.claudeTools.some((t: any) => t?.name === "ExitPlanMode") ||
      ctx.tools.some((t: any) => (t?.function ?? t)?.name === "ExitPlanMode");
    if (!hasExitPlanMode) return [];

    // The original reminder is a system message that, in the sessions that
    // failed, sat ~180K tokens behind the current turn. A tool description is
    // re-read at the moment the model decides to call the tool, which is exactly
    // when this fact needs to be in front of it.
    return [
      {
        type: "rewriteToolDescription",
        tool: "ExitPlanMode",
        append: `

## Plan file for THIS session
Your plan MUST be written to exactly this path:
${planFilePath}
Do not invent a different filename, and do not derive one from the task. Claude Code reads only that exact path; a plan written anywhere else is invisible to it and the approval will show "No plan found".`,
      },
    ];
  },

  onToolCall(ctx) {
    const { planFilePath, planDir } = ctx.harness;
    if (!planFilePath || !planDir) return [];

    const filePath = ctx.args.file_path;
    if (typeof filePath !== "string" || filePath === planFilePath) return [];

    // Only ever redirect writes that are ALREADY aimed at the plan directory.
    // A model writing source files, docs, or session artifacts elsewhere is
    // doing normal work and must not be touched.
    if (directoryOf(filePath) !== planDir) return [];

    return [
      {
        type: "repairToolArgs",
        args: { ...ctx.args, file_path: planFilePath },
        reason:
          `redirected ${ctx.toolName} from ${filePath} to the session's assigned ` +
          `plan file ${planFilePath}`,
      },
    ];
  },
};

export const PLAN_MODE_RULES: BehaviorRule[] = [planFilePathRule];
