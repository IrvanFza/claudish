/**
 * Behavior rule engine.
 *
 * Rules return actions; the engine applies them. Nothing else in the layer is
 * allowed to mutate the request, which is what makes severity levels meaningful
 * and every change traceable to a rule id.
 *
 * CONCURRENCY: ComposedHandler is cached per model and can serve overlapping
 * requests, so per-request state (detected harness facts, the active rule set)
 * lives on a BehaviorSession created by `startSession()` — never on the engine.
 * The stream-parser closure captures its own session, so two in-flight requests
 * cannot read each other's plan file path.
 */

import { log } from "../logger.js";
import { resolveSeverity } from "./config.js";
import { detectHarnessFacts } from "./harness.js";
import type {
  BehaviorConfig,
  BehaviorContext,
  BehaviorRule,
  HarnessFacts,
  RuleAction,
  Severity,
} from "./types.js";

interface ActiveRule {
  rule: BehaviorRule;
  severity: Severity;
}

/** Per-request state. Created by BehaviorEngine.startSession(). */
export class BehaviorSession {
  private facts: HarnessFacts = { planModeActive: false };
  /**
   * Populated only once the request has been inspected. Empty until then, so a
   * request that never calls applyRequest buffers nothing.
   */
  private bufferedTools = new Set<string>();

  constructor(
    private readonly active: ActiveRule[],
    private readonly modelId: string,
    private readonly providerName: string
  ) {}

  /**
   * Decide which tools need buffering, now that harness state is known.
   *
   * Two gates, both necessary. A rule at `warn` cannot apply a repair, so
   * buffering for it would be pure cost; and a rule that is not armed for this
   * request (e.g. a plan-mode rule outside plan mode) cannot fire at all. The
   * net effect is that ordinary sessions stream tool arguments incrementally
   * exactly as they did before this layer existed.
   */
  private armBuffering(): void {
    const armed = new Set<string>();
    for (const { rule, severity } of this.active) {
      if (severity !== "fix") continue;
      if (rule.armed && !rule.armed(this.facts)) continue;
      for (const t of rule.interceptsTools ?? []) armed.add(t);
    }
    this.bufferedTools = armed;
  }

  get harness(): HarnessFacts {
    return this.facts;
  }

  /** True when no rule is active — lets callers skip work entirely. */
  get isNoop(): boolean {
    return this.active.length === 0;
  }

  /**
   * Run request-time rules. Called from the middleware `beforeRequest` hook,
   * which the pipeline guarantees runs before `buildPayload`.
   */
  applyRequest(claudeRequest: any, claudeTools: any[], tools: any[], messages: any[]): void {
    if (this.active.length === 0) return;

    this.facts = detectHarnessFacts(claudeRequest);
    this.armBuffering();

    const ctx: BehaviorContext = {
      modelId: this.modelId,
      providerName: this.providerName,
      isNativeAnthropic: false,
      claudeRequest,
      claudeTools,
      tools,
      messages,
      harness: this.facts,
    };

    for (const { rule, severity } of this.active) {
      if (!rule.onRequest) continue;
      let actions: RuleAction[] = [];
      try {
        actions = rule.onRequest(ctx) ?? [];
      } catch (err) {
        // A broken rule degrades to no-op. It must never fail the user's request.
        log(`[behavior] rule ${rule.id} onRequest threw: ${err}`);
        continue;
      }
      for (const action of actions) this.applyAction(rule.id, severity, action, ctx);
    }
  }

  /** Whether this tool's arguments must be buffered so a repair can land. */
  interceptsTool(toolName: string): boolean {
    return this.bufferedTools.has(toolName);
  }

  /**
   * Offer a completed tool call to the rules.
   *
   * @returns replacement argument JSON, or null to leave the call untouched.
   */
  repairToolCall(toolName: string, rawArgs: string): string | null {
    if (!this.bufferedTools.has(toolName)) return null;

    let args: Record<string, any> = {};
    try {
      const parsed = JSON.parse(rawArgs || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
    } catch {
      // Malformed JSON is the recovery layer's problem, not ours. Leave it be.
      return null;
    }

    let changed = false;
    for (const { rule, severity } of this.active) {
      if (!rule.onToolCall) continue;
      if (!(rule.interceptsTools ?? []).includes(toolName)) continue;

      let actions: RuleAction[] = [];
      try {
        actions =
          rule.onToolCall({
            modelId: this.modelId,
            toolName,
            args,
            rawArgs,
            harness: this.facts,
          }) ?? [];
      } catch (err) {
        log(`[behavior] rule ${rule.id} onToolCall threw: ${err}`);
        continue;
      }

      for (const action of actions) {
        if (action.type === "warn") {
          log(`[behavior] ${rule.id} (warn): ${action.message}`);
          continue;
        }
        if (action.type !== "repairToolArgs") continue;
        if (severity !== "fix") {
          log(`[behavior] ${rule.id} (warn-only, not applied): ${action.reason}`);
          continue;
        }
        args = action.args;
        changed = true;
        // Deliberately log-file only, not stderr: claudish shares stdio with the
        // Claude Code TUI and stray stderr writes corrupt its rendering.
        log(`[behavior] ${rule.id} repaired ${toolName}: ${action.reason}`);
      }
    }

    return changed ? JSON.stringify(args) : null;
  }

  private applyAction(
    ruleId: string,
    severity: Severity,
    action: RuleAction,
    ctx: BehaviorContext
  ): void {
    if (action.type === "warn") {
      log(`[behavior] ${ruleId} (warn): ${action.message}`);
      return;
    }
    if (severity !== "fix") {
      log(`[behavior] ${ruleId} (warn-only, not applied): ${action.type}`);
      return;
    }

    switch (action.type) {
      case "injectSystemNote": {
        const req = ctx.claudeRequest;
        if (typeof req.system === "string") {
          req.system = `${req.system}\n\n${action.text}`;
        } else if (Array.isArray(req.system)) {
          req.system.push({ type: "text", text: action.text });
        } else {
          req.system = action.text;
        }
        log(`[behavior] ${ruleId} injected system note (${action.text.length} chars)`);
        break;
      }
      case "rewriteToolDescription": {
        // Applied to BOTH representations. The converted array is what the
        // Chat Completions payload aliases and what Codex's buildPayload reads
        // when it rebuilds each tool; claudeTools is what any later
        // re-conversion would read. Updating one alone silently misses a path.
        let hits = 0;
        for (const t of ctx.claudeTools) {
          if (t?.name !== action.tool) continue;
          t.description = `${t.description ?? ""}${action.append}`;
          hits++;
        }
        for (const t of ctx.tools) {
          const fn = t?.function ?? t;
          if (fn?.name !== action.tool) continue;
          fn.description = `${fn.description ?? ""}${action.append}`;
          hits++;
        }
        log(`[behavior] ${ruleId} rewrote description of ${action.tool} (${hits} site(s))`);
        break;
      }
      case "repairToolArgs":
        // Only meaningful inside repairToolCall(); ignored at request time.
        log(`[behavior] ${ruleId} returned repairToolArgs from onRequest — ignored`);
        break;
    }
  }
}

export class BehaviorEngine {
  constructor(
    private readonly config: BehaviorConfig,
    private readonly rules: BehaviorRule[]
  ) {}

  /**
   * Build the per-request session.
   *
   * Rules are gated here, once, so the hot paths (`interceptsTool`, called per
   * tool call) are set lookups rather than repeated predicate evaluation.
   */
  startSession(params: {
    modelId: string;
    providerName: string;
    isNativeAnthropic: boolean;
  }): BehaviorSession {
    const active: ActiveRule[] = [];

    // Native Claude models already follow Claude Code's conventions — the whole
    // layer stays off for them so a no-op layer is genuinely a no-op.
    if (!params.isNativeAnthropic) {
      for (const rule of this.rules) {
        const severity = resolveSeverity(rule.id, rule.defaultSeverity, this.config);
        if (severity === "off") continue;
        let applies = false;
        try {
          applies = rule.appliesTo(params);
        } catch (err) {
          log(`[behavior] rule ${rule.id} appliesTo threw: ${err}`);
          continue;
        }
        if (applies) active.push({ rule, severity });
      }
    }

    if (active.length > 0) {
      log(
        `[behavior] ${active.length} rule(s) active for ${params.modelId}: ` +
          active.map((a) => `${a.rule.id}=${a.severity}`).join(", ")
      );
    }

    return new BehaviorSession(active, params.modelId, params.providerName);
  }
}
