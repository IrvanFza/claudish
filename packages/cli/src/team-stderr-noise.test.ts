import { describe, expect, it } from "bun:test";
import { meaningfulStderr } from "./team-orchestrator.js";

const BENIGN_LINE =
  '[claude-code:unrecognized_model] {"model":"x-ai@grok-4.6","query_source":"sdk"}';

describe("meaningfulStderr", () => {
  it("returns empty output for empty and whitespace-only stderr", () => {
    expect(meaningfulStderr("")).toBe("");
    expect(meaningfulStderr("  \n\t  ")).toBe("");
  });

  it("strips the real Claude Code unrecognized-model line", () => {
    expect(meaningfulStderr(BENIGN_LINE)).toBe("");
  });

  it("strips the benign line when it has leading whitespace", () => {
    expect(meaningfulStderr(`   ${BENIGN_LINE}`)).toBe("");
  });

  it("preserves a real provider error verbatim", () => {
    const providerError = "Provider error: upstream request timed out";

    expect(meaningfulStderr(providerError)).toBe(providerError);
  });

  it("keeps only the real error from mixed stderr", () => {
    const providerError = "Provider error: upstream request timed out";

    expect(meaningfulStderr(`${BENIGN_LINE}\n${providerError}`)).toBe(providerError);
  });

  it("does not strip prose that merely mentions unrecognized_model", () => {
    const providerError = "Provider reported unrecognized_model while handling the request";

    expect(meaningfulStderr(providerError)).toBe(providerError);
  });
});
