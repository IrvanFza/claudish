import { beforeEach, describe, expect, test } from "bun:test";
import {
  type AntigravityToken,
  type AntigravityTokenDeps,
  _resetAntigravityTokenState,
  deleteSharedAntigravityToken,
  getValidAntigravityAccessToken,
  readSharedAntigravityToken,
  writeSharedAntigravityToken,
} from "./antigravity-token.js";

const PREFIX = "go-keyring-base64:";
const NOW = Date.parse("2026-08-04T00:00:00.000Z");

interface StoreRecord {
  token: AntigravityToken;
  id_token?: string;
  auth_method?: string;
  [key: string]: unknown;
}

function makeToken(overrides: Partial<AntigravityToken> = {}): AntigravityToken {
  return {
    access_token: "expired-access-token",
    token_type: "Bearer",
    refresh_token: "refresh-token",
    expiry: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function encodeStore(record: StoreRecord): string {
  return PREFIX + Buffer.from(JSON.stringify(record), "utf8").toString("base64");
}

function decodeStore(raw: string): StoreRecord {
  expect(raw.startsWith(PREFIX)).toBe(true);
  return JSON.parse(Buffer.from(raw.slice(PREFIX.length), "base64").toString("utf8"));
}

function makeFakeDeps(
  initialStore: string | null,
  onRefresh: (setStore: (raw: string | null) => void) => void = () => {}
) {
  let store = initialStore;
  let refreshCallCount = 0;
  let deleteCallCount = 0;
  const writes: string[] = [];
  const setStore = (raw: string | null): void => {
    store = raw;
  };

  const deps: AntigravityTokenDeps = {
    readStore: () => store,
    writeStore: (raw) => {
      writes.push(raw);
      store = raw;
    },
    deleteStore: () => {
      deleteCallCount += 1;
      store = null;
    },
    runAgyRefresh: () => {
      refreshCallCount += 1;
      onRefresh(setStore);
    },
    now: () => NOW,
  };

  return {
    deps,
    writes,
    getStore: () => store,
    getRefreshCallCount: () => refreshCallCount,
    getDeleteCallCount: () => deleteCallCount,
  };
}

beforeEach(() => {
  _resetAntigravityTokenState();
});

describe("readSharedAntigravityToken", () => {
  test("parses a valid go-keyring-base64 value", () => {
    const token = makeToken({
      access_token: "stored-access-token",
      expiry: new Date(NOW + 10 * 60_000).toISOString(),
    });
    const fake = makeFakeDeps(
      encodeStore({ token, id_token: "stored-id-token", auth_method: "oauth" })
    );

    expect(readSharedAntigravityToken(fake.deps)).toEqual(token);
  });

  test("returns null for an unsupported keyring prefix", () => {
    const fake = makeFakeDeps("go-keyring-chunked:opaque-value");

    expect(readSharedAntigravityToken(fake.deps)).toBeNull();
  });

  test("returns null for an empty store", () => {
    const fake = makeFakeDeps(null);

    expect(readSharedAntigravityToken(fake.deps)).toBeNull();
  });
});

describe("writeSharedAntigravityToken", () => {
  test("preserves record metadata and round-trips the replacement token", () => {
    const replacement = makeToken({
      access_token: "fresh-access-token",
      refresh_token: "fresh-refresh-token",
      expiry: new Date(NOW + 60 * 60_000).toISOString(),
    });
    const fake = makeFakeDeps(
      encodeStore({
        token: makeToken(),
        id_token: "preserved-id-token",
        auth_method: "antigravity-oauth",
      })
    );

    writeSharedAntigravityToken(replacement, fake.deps);

    expect(fake.writes).toHaveLength(1);
    expect(decodeStore(fake.writes[0])).toEqual({
      token: replacement,
      id_token: "preserved-id-token",
      auth_method: "antigravity-oauth",
    });
    expect(readSharedAntigravityToken(fake.deps)).toEqual(replacement);
  });
});

describe("deleteSharedAntigravityToken", () => {
  test("uses the injected delete path", () => {
    const fake = makeFakeDeps(encodeStore({ token: makeToken() }));

    deleteSharedAntigravityToken(fake.deps);

    expect(fake.getDeleteCallCount()).toBe(1);
    expect(fake.getStore()).toBeNull();
  });
});

describe("getValidAntigravityAccessToken", () => {
  test.skipIf(process.platform !== "darwin")(
    "returns a valid token without asking agy to refresh",
    async () => {
      const token = makeToken({
        access_token: "valid-access-token",
        expiry: new Date(NOW + 10 * 60_000).toISOString(),
      });
      const fake = makeFakeDeps(encodeStore({ token }));

      await expect(getValidAntigravityAccessToken(fake.deps)).resolves.toBe("valid-access-token");
      expect(fake.getRefreshCallCount()).toBe(0);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "re-reads and returns the token refreshed by agy",
    async () => {
      const freshToken = makeToken({
        access_token: "fresh-access-token",
        refresh_token: "rotated-refresh-token",
        expiry: new Date(NOW + 60 * 60_000).toISOString(),
      });
      const fake = makeFakeDeps(encodeStore({ token: makeToken() }), (setStore) => {
        setStore(encodeStore({ token: freshToken }));
      });

      await expect(getValidAntigravityAccessToken(fake.deps)).resolves.toBe("fresh-access-token");
      expect(fake.getRefreshCallCount()).toBe(1);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "throws an actionable error when agy leaves the expired store unchanged",
    async () => {
      const fake = makeFakeDeps(encodeStore({ token: makeToken() }));

      await expect(getValidAntigravityAccessToken(fake.deps)).rejects.toThrow(
        /claudish login antigravity/
      );
      expect(fake.getRefreshCallCount()).toBe(1);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "throws an actionable error when no shared session exists",
    async () => {
      const fake = makeFakeDeps(null);

      await expect(getValidAntigravityAccessToken(fake.deps)).rejects.toThrow(
        /claudish login antigravity/
      );
      expect(fake.getRefreshCallCount()).toBe(0);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "shares one agy refresh across concurrent callers",
    async () => {
      const freshToken = makeToken({
        access_token: "single-flight-access-token",
        expiry: new Date(NOW + 60 * 60_000).toISOString(),
      });
      const fake = makeFakeDeps(encodeStore({ token: makeToken() }), (setStore) => {
        setStore(encodeStore({ token: freshToken }));
      });

      const first = getValidAntigravityAccessToken(fake.deps);
      const second = getValidAntigravityAccessToken(fake.deps);

      await expect(Promise.all([first, second])).resolves.toEqual([
        "single-flight-access-token",
        "single-flight-access-token",
      ]);
      expect(fake.getRefreshCallCount()).toBe(1);
    }
  );
});
