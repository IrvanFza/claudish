import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { __resetSniffForTests } from "./op-source.js";
import { prehydrateCredentialsForSpawn } from "./prehydrate.js";

let savedDisableOp: string | undefined;

beforeEach(() => {
  savedDisableOp = process.env.CLAUDISH_DISABLE_OP;
  process.env.CLAUDISH_DISABLE_OP = "1";
  __resetSniffForTests();
});

afterEach(() => {
  if (savedDisableOp === undefined) delete process.env.CLAUDISH_DISABLE_OP;
  else process.env.CLAUDISH_DISABLE_OP = savedDisableOp;
  __resetSniffForTests();
});

describe("prehydrateCredentialsForSpawn", () => {
  it("is a no-op for empty and undefined-only model lists", async () => {
    expect(await prehydrateCredentialsForSpawn([])).toBeUndefined();
    expect(await prehydrateCredentialsForSpawn([undefined, undefined])).toBeUndefined();
  });

  it("does not throw for a network-free local-model validation", async () => {
    expect(await prehydrateCredentialsForSpawn(["ollama@llama3.2"])).toBeUndefined();
  });

  it.skip("swallows a thrown validateApiKeysForModels call without a process-global module mock", () => {
    // validateApiKeysForModels has no injectable test seam, and production
    // credential-provider errors are already swallowed by CredentialAuthority.
    // A mock.module replacement would bleed into sibling Bun test files, so the
    // exceptional path stays explicitly skipped until a local seam exists.
  });
});
