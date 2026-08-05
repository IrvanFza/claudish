import { describe, expect, test } from "bun:test";
import { isQuotaExhaustionError } from "./quota-exhaustion.js";

const KIMI_EXHAUSTION_BODY =
  '{"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing"}}';

describe("isQuotaExhaustionError", () => {
  test("detects the captured Kimi permission_error at status 403", () => {
    expect(isQuotaExhaustionError(403, KIMI_EXHAUSTION_BODY)).toBe(true);
  });

  test("detects the captured Kimi exhaustion body at statuses 401 and 429", () => {
    expect(isQuotaExhaustionError(401, KIMI_EXHAUSTION_BODY)).toBe(true);
    expect(isQuotaExhaustionError(429, KIMI_EXHAUSTION_BODY)).toBe(true);
  });

  test("rejects the captured Kimi exhaustion body for unrelated statuses", () => {
    for (const status of [200, 400, 404, 500, 503]) {
      expect(isQuotaExhaustionError(status, KIMI_EXHAUSTION_BODY)).toBe(false);
    }
  });

  test("explicitly excludes status 402 because payment required is handled separately", () => {
    expect(isQuotaExhaustionError(402, KIMI_EXHAUSTION_BODY)).toBe(false);
  });

  describe("genuine authentication failures", () => {
    const authFailureBodies = [
      '{"error":{"message":"invalid api key"}}',
      '{"error":{"message":"Unauthorized"}}',
      '{"error":{"type":"permission_error","message":"Permission denied"}}',
      '{"error":{"message":"Forbidden"}}',
      '{"error":{"message":"authentication failed"}}',
      '{"error":{"message":"invalid client id"}}',
    ] as const;

    for (const status of [401, 403]) {
      for (const body of authFailureBodies) {
        test(`does not classify ${body} at status ${status} as quota exhaustion`, () => {
          expect(isQuotaExhaustionError(status, body)).toBe(false);
        });
      }
    }

    test("keys off limit wording rather than permission_error", () => {
      const permissionDeniedBody =
        '{"error":{"type":"permission_error","message":"Permission denied"}}';

      expect(isQuotaExhaustionError(403, KIMI_EXHAUSTION_BODY)).toBe(true);
      expect(isQuotaExhaustionError(403, permissionDeniedBody)).toBe(false);
    });
  });

  describe("other exhaustion wordings", () => {
    const exhaustionWordings = [
      "insufficient balance",
      "insufficient_quota",
      "You exceeded your current quota",
      "out of credits",
      "credit balance is too low",
      "upgrade your plan",
    ] as const;

    for (const wording of exhaustionWordings) {
      test(`detects \"${wording}\" at status 403`, () => {
        expect(isQuotaExhaustionError(403, wording)).toBe(true);
      });
    }
  });

  test("returns false for an empty body", () => {
    expect(isQuotaExhaustionError(403, "")).toBe(false);
  });

  test("matches Kimi's exhaustion message case-insensitively", () => {
    expect(isQuotaExhaustionError(403, KIMI_EXHAUSTION_BODY.toUpperCase())).toBe(true);
  });
});

describe("fallback quota-exhaustion contract", () => {
  // fallback-handler.ts consumes this predicate before its auth fallback gate.
  test("detects an exhaustion 403 so fallback can keep it terminal", () => {
    expect(isQuotaExhaustionError(403, KIMI_EXHAUSTION_BODY)).toBe(true);
  });

  test("does not detect a plain auth 403 so fallback can advance the provider chain", () => {
    expect(isQuotaExhaustionError(403, '{"error":{"message":"Forbidden"}}')).toBe(false);
  });
});
