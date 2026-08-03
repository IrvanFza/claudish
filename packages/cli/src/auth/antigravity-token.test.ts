import { beforeEach, describe, expect, test } from "bun:test";
import {
  type AntigravityToken,
  type AntigravityTokenDeps,
  type ClientCred,
  _resetAntigravityTokenState,
  getValidAntigravityAccessToken,
  readSharedAntigravityToken,
  writeSharedAntigravityToken,
} from "./antigravity-token.js";

const PREFIX = "go-keyring-base64:";
const NOW = Date.parse("2026-08-03T00:00:00.000Z");

interface StoreRecord {
  token: AntigravityToken;
  id_token?: string;
  auth_method?: string;
  [key: string]: unknown;
}

function makeToken(overrides: Partial<AntigravityToken> = {}): AntigravityToken {
  return {
    access_token: "ya29.OLD",
    token_type: "Bearer",
    refresh_token: "OLDREFRESH",
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

interface FakeDepsOptions {
  creds?: ClientCred[];
  fetch?: AntigravityTokenDeps["fetch"];
  now?: number;
}

function makeFakeDeps(initialStore: string | null, options: FakeDepsOptions = {}) {
  let store = initialStore;
  let extractCredsCallCount = 0;
  const writes: string[] = [];
  const fetchCalls: Array<{
    input: Parameters<AntigravityTokenDeps["fetch"]>[0];
    init: Parameters<AntigravityTokenDeps["fetch"]>[1];
  }> = [];
  const fakeFetch: AntigravityTokenDeps["fetch"] =
    options.fetch ??
    (async () => {
      throw new Error("Unexpected fetch");
    });

  const deps: AntigravityTokenDeps = {
    readStore: () => store,
    writeStore: (rawValue) => {
      writes.push(rawValue);
      store = rawValue;
    },
    extractCreds: () => {
      extractCredsCallCount += 1;
      return options.creds ?? [];
    },
    fetch: async (input, init) => {
      fetchCalls.push({ input, init });
      return fakeFetch(input, init);
    },
    now: () => options.now ?? NOW,
  };

  return {
    deps,
    fetchCalls,
    writes,
    getExtractCredsCallCount: () => extractCredsCallCount,
    setStore: (rawValue: string | null) => {
      store = rawValue;
    },
  };
}

beforeEach(() => {
  _resetAntigravityTokenState();
});

describe("readSharedAntigravityToken", () => {
  test("parses a well-formed go-keyring-base64 record", () => {
    const token = makeToken({
      access_token: "ya29.STORED",
      refresh_token: "STOREDREFRESH",
      expiry: new Date(NOW + 3_600_000).toISOString(),
    });
    const fake = makeFakeDeps(
      encodeStore({ token, id_token: "stored-id-token", auth_method: "oauth" })
    );

    expect(readSharedAntigravityToken(fake.deps)).toEqual(token);
  });

  test("returns null for unsupported keyring formats", () => {
    const fake = makeFakeDeps("go-keyring-chunked:opaque-value");

    expect(readSharedAntigravityToken(fake.deps)).toBeNull();
  });

  test("returns null for missing or empty stores", () => {
    const missing = makeFakeDeps(null);
    const empty = makeFakeDeps("");

    expect(readSharedAntigravityToken(missing.deps)).toBeNull();
    expect(readSharedAntigravityToken(empty.deps)).toBeNull();
  });
});

describe("writeSharedAntigravityToken", () => {
  test("preserves record metadata and round-trips the replacement token", () => {
    const oldToken = makeToken();
    const newToken = makeToken({
      access_token: "ya29.NEW",
      refresh_token: "NEWREFRESH",
      expiry: new Date(NOW + 3_599_000).toISOString(),
    });
    const fake = makeFakeDeps(
      encodeStore({
        token: oldToken,
        id_token: "preserve-this-id-token",
        auth_method: "antigravity-oauth",
      })
    );

    writeSharedAntigravityToken(newToken, fake.deps);

    expect(fake.writes).toHaveLength(1);
    const writtenRecord = decodeStore(fake.writes[0]);
    expect(writtenRecord.id_token).toBe("preserve-this-id-token");
    expect(writtenRecord.auth_method).toBe("antigravity-oauth");
    expect(writtenRecord.token).toEqual(newToken);
    expect(readSharedAntigravityToken(fake.deps)).toEqual(newToken);
  });
});

describe("getValidAntigravityAccessToken", () => {
  test("returns a still-valid token without fetching or writing", async () => {
    const token = makeToken({ expiry: new Date(NOW + 10 * 60_000).toISOString() });
    const fake = makeFakeDeps(encodeStore({ token }));

    await expect(getValidAntigravityAccessToken(fake.deps)).resolves.toBe("ya29.OLD");
    expect(fake.fetchCalls).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
  });

  test("refreshes an expired token and writes the rotated refresh token", async () => {
    const fake = makeFakeDeps(encodeStore({ token: makeToken() }), {
      creds: [
        { clientId: "client-one", clientSecret: "secret-one" },
        { clientId: "client-two", clientSecret: "secret-two" },
      ],
      fetch: async () =>
        Response.json({
          access_token: "ya29.NEW",
          expires_in: 3599,
          refresh_token: "NEWREFRESH",
        }),
    });

    await expect(getValidAntigravityAccessToken(fake.deps)).resolves.toBe("ya29.NEW");

    expect(fake.fetchCalls).toHaveLength(1);
    expect(fake.writes).toHaveLength(1);
    const writtenToken = decodeStore(fake.writes[0]).token;
    expect(writtenToken.access_token).toBe("ya29.NEW");
    expect(writtenToken.refresh_token).toBe("NEWREFRESH");
    expect(writtenToken.expiry).toBe(new Date(NOW + 3599 * 1000).toISOString());
    expect(Date.parse(writtenToken.expiry)).toBeGreaterThan(NOW);
  });

  test("discovers a working credential combination and caches the winner", async () => {
    const attemptedClientIds: string[] = [];
    const badCombo = { clientId: "bad-client", clientSecret: "bad-secret" };
    const goodCombo = { clientId: "good-client", clientSecret: "good-secret" };
    const fake = makeFakeDeps(encodeStore({ token: makeToken() }), {
      creds: [badCombo, goodCombo],
      fetch: async (_input, init) => {
        const body = new URLSearchParams(String(init?.body));
        const clientId = body.get("client_id") ?? "";
        attemptedClientIds.push(clientId);
        if (clientId === badCombo.clientId) {
          return new Response("invalid client", { status: 401 });
        }
        return Response.json({ access_token: "ya29.GOOD", expires_in: 3599 });
      },
    });

    await expect(getValidAntigravityAccessToken(fake.deps)).resolves.toBe("ya29.GOOD");
    expect(attemptedClientIds).toEqual(["bad-client", "good-client"]);

    fake.setStore(
      encodeStore({
        token: makeToken({ access_token: "ya29.STALE-AGAIN" }),
      })
    );
    await expect(getValidAntigravityAccessToken(fake.deps)).resolves.toBe("ya29.GOOD");

    expect(attemptedClientIds).toEqual(["bad-client", "good-client", "good-client"]);
    expect(fake.getExtractCredsCallCount()).toBe(1);
  });

  test("throws an actionable error when no shared session exists", async () => {
    const fake = makeFakeDeps(null);
    let thrown: unknown;

    try {
      await getValidAntigravityAccessToken(fake.deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message.length).toBeGreaterThan(0);
    expect(message).toMatch(/Antigravity/i);
    expect(message).toMatch(/sign in/i);
  });

  test("shares one refresh across concurrent callers", async () => {
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fake = makeFakeDeps(encodeStore({ token: makeToken() }), {
      creds: [{ clientId: "client", clientSecret: "secret" }],
      fetch: async () => pendingFetch,
    });

    const first = getValidAntigravityAccessToken(fake.deps);
    const second = getValidAntigravityAccessToken(fake.deps);
    await Promise.resolve();

    expect(fake.fetchCalls).toHaveLength(1);
    resolveFetch(Response.json({ access_token: "ya29.SINGLE", expires_in: 3599 }));
    await expect(Promise.all([first, second])).resolves.toEqual(["ya29.SINGLE", "ya29.SINGLE"]);
    expect(fake.fetchCalls).toHaveLength(1);
  });
});
