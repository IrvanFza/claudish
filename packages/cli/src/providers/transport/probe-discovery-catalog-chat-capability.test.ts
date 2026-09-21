import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type DiskCacheV3, type SlimModelEntry, writeAllModelsCache } from "../all-models-cache.js";
import {
  _clearChatCapabilityIndex,
  classifyChatCapability,
  isChatCapable,
} from "./probe-discovery.js";

interface CatalogFixture {
  provenance: { catalogGenerationId: string };
  entries: SlimModelEntry[];
}

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../../test-fixtures/catalog-v3/rows-g-20260919013346169.json"),
    "utf-8"
  )
) as CatalogFixture;

let tempDir = "";
let cachePath = "";

beforeEach(() => {
  _clearChatCapabilityIndex();
  tempDir = mkdtempSync(join(tmpdir(), "claudish-chat-capability-"));
  cachePath = join(tempDir, "cloud-models-catalog-v3.json");
  const cache: DiskCacheV3 = {
    version: 3,
    lastUpdated: "2026-09-19T01:33:46.169Z",
    catalogGenerationId: fixture.provenance.catalogGenerationId,
    entries: fixture.entries,
    models: [],
    plans: [],
  };
  writeAllModelsCache(cache, cachePath);
});

afterEach(() => {
  _clearChatCapabilityIndex();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("chat capability from the catalog", () => {
  // Mutation targets: probe-discovery.ts:150, :181 and :195. Removing the catalog
  // videoOutput denial breaks Omni; treating videoInput as output breaks 3.8 Flash;
  // requiring literal "chat" instead of anything but "not-chat" breaks unknowns.
  test("video output is not chat", () => {
    expect(classifyChatCapability("gemini-omni-1.1-flash", cachePath)).toBe("not-chat");
  });

  test("video input alone does not exclude a chat model", () => {
    expect(classifyChatCapability("gemini-3.8-flash", cachePath)).not.toBe("not-chat");
  });

  test("the video-name fallback applies to names absent from the catalog", () => {
    expect(classifyChatCapability("unpublished-model-t2v", cachePath)).toBe("not-chat");
  });

  test.each(["unpublished-model-t2v", "unpublished-chat-model"])(
    "isChatCapable is the boolean projection for %s",
    (name) => {
      expect(isChatCapable(name)).toBe(classifyChatCapability(name) !== "not-chat");
    }
  );
});
