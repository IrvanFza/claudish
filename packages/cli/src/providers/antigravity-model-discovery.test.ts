import { describe, expect, test } from "bun:test";

import { getProviderByName } from "./provider-definitions.js";

describe("Antigravity model discovery definition", () => {
  test("declares the dedicated live Antigravity response format", () => {
    const definition = getProviderByName("antigravity");

    // This opt-in is what routes discovery away from the generic authenticated GET path.
    expect(definition?.modelDiscovery).toEqual({ path: "", format: "antigravity" });
  });
});
