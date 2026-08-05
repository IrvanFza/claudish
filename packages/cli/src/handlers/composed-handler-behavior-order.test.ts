import { beforeEach, describe, expect, it } from "bun:test";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { resetBehaviorEngine } from "../behavior/index.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

interface CapturedBuildInput {
  messages: any[];
  tools: any[];
  system: any;
}

class RecordingOpenAIAPIFormat extends OpenAIAPIFormat {
  captured?: CapturedBuildInput;

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    this.captured = JSON.parse(JSON.stringify({ messages, tools, system: claudeRequest.system }));
    return super.buildPayload(claudeRequest, messages, tools);
  }
}

function makeFakeTransport(): ProviderTransport {
  return {
    name: "test-provider",
    displayName: "Test",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://127.0.0.1:1/",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

function makePayload(model: string): any {
  return {
    model,
    max_tokens: 16,
    messages: [
      {
        role: "user",
        content:
          "No plan file exists yet. You should create your plan at /tmp/behavior-order-test/assigned-plan.md using the Write tool.",
      },
    ],
    tools: [
      {
        name: "ExitPlanMode",
        description: "Exit plan mode after writing the plan.",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
}

function exitPlanModeDescription(adapter: RecordingOpenAIAPIFormat): string {
  const tool = adapter.captured?.tools.find(
    (candidate: any) => (candidate.function ?? candidate).name === "ExitPlanMode"
  );
  return (tool?.function ?? tool)?.description ?? "";
}

async function captureBuildInput(model: string): Promise<RecordingOpenAIAPIFormat> {
  const adapter = new RecordingOpenAIAPIFormat(model);
  const handler = new ComposedHandler(makeFakeTransport(), model, model, 8080, { adapter });
  const context = {
    json: (body: any, status: number) => ({ body, status }),
    body: (...args: any[]) => ({ args }),
  } as any;

  try {
    await handler.handle(context, makePayload(model));
  } catch {
    // The fake transport deliberately points at an unroutable local endpoint.
  }

  return adapter;
}

describe("ComposedHandler behavior layer ordering", () => {
  beforeEach(() => {
    resetBehaviorEngine();
  });

  it("applies behavior mutations before adapter.buildPayload for foreign models", async () => {
    const adapter = await captureBuildInput("gpt-5.6-sol");

    // This can only be captured if behavior ran before buildPayload; moving the
    // call back after buildPayload must fail this regression test.
    expect(exitPlanModeDescription(adapter)).toContain("assigned-plan.md");
  });

  it("keeps behavior mutations off for native Claude models", async () => {
    const adapter = await captureBuildInput("claude-opus-4-8");

    expect(exitPlanModeDescription(adapter)).not.toContain("assigned-plan.md");
  });
});
