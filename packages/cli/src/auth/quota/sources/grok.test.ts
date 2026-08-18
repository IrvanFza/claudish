import { describe, expect, test } from "bun:test";

import { reportableQuotaAdapters, resolveQuotaAdapter } from "../registry.js";
import { codexQuotaAdapter } from "./codex.js";
import { grokQuotaAdapter, periodLabel, windowsFromBilling } from "./grok.js";

const CAPTURED_BILLING_CONFIG = {
  creditUsagePercent: 1.0,
  currentPeriod: {
    type: "USAGE_PERIOD_TYPE_WEEKLY",
    start: "2026-08-14T06:16:23.162912+00:00",
    end: "2026-08-21T06:16:23.162912+00:00",
  },
  productUsage: [
    { product: "GrokBuild", usagePercent: 1.0 },
    { product: "GrokChat" },
    { product: "GrokImagine" },
  ],
};

describe("Grok billing period labels", () => {
  test.each([
    ["USAGE_PERIOD_TYPE_WEEKLY", "7d"],
    ["USAGE_PERIOD_TYPE_DAILY", "24h"],
    ["USAGE_PERIOD_TYPE_MONTHLY", "30d"],
    [undefined, "period"],
  ])("maps %s to %s", (type, expected) => {
    expect(periodLabel(type)).toBe(expected);
  });

  test("degrades an unknown backend enum to a usable label", () => {
    // A new period type must still produce a window instead of making Grok look unsupported.
    expect(periodLabel("USAGE_PERIOD_TYPE_FORTNIGHTLY")).toBe("fortnightly");
  });
});

describe("Grok billing windows", () => {
  test("parses the real captured product-level response", () => {
    expect(windowsFromBilling(CAPTURED_BILLING_CONFIG)).toEqual([
      {
        id: "GrokBuild",
        used_pct: 1,
        resets_at: "2026-08-21T06:16:23.162912+00:00",
      },
    ]);
  });

  test("prefers metered products over the account roll-up", () => {
    const windows = windowsFromBilling({
      creditUsagePercent: 12,
      productUsage: [{ product: "GrokBuild", usagePercent: 99 }],
    });

    // Claudish spends GrokBuild, whose separate meter may be near its limit while the roll-up is low.
    expect(windows).toEqual([{ id: "GrokBuild", used_pct: 99 }]);
  });

  test("omits products that do not publish a percentage", () => {
    const windows = windowsFromBilling({
      productUsage: [
        { product: "GrokBuild", usagePercent: 1 },
        { product: "GrokChat" },
        { product: "GrokImagine" },
      ],
    });

    // A product without a real limit must not render as a permanent phantom 0% window.
    expect(windows.map((window) => window.id)).toEqual(["GrokBuild"]);
  });

  test("falls back from the current period end to the billing period end", () => {
    expect(
      windowsFromBilling({
        currentPeriod: { type: "USAGE_PERIOD_TYPE_DAILY" },
        billingPeriodEnd: "2026-08-22T00:00:00Z",
        productUsage: [{ product: "GrokBuild", usagePercent: 7 }],
      })
    ).toEqual([
      {
        id: "GrokBuild",
        used_pct: 7,
        resets_at: "2026-08-22T00:00:00Z",
      },
    ]);
  });

  test("omits resets_at when neither reset source is present", () => {
    const [window] = windowsFromBilling({
      productUsage: [{ product: "GrokBuild", usagePercent: 7 }],
    });

    // Absence preserves the optional-field contract; an undefined-valued key is not wire-equivalent.
    expect(window).toEqual({ id: "GrokBuild", used_pct: 7 });
    expect("resets_at" in window).toBe(false);
  });

  test("falls back to one labelled account window without product-level usage", () => {
    const expected = [{ id: "7d", used_pct: 42 }];

    expect(
      windowsFromBilling({
        creditUsagePercent: 42,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
      })
    ).toEqual(expected);
    expect(
      windowsFromBilling({
        creditUsagePercent: 42,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
        productUsage: [],
      })
    ).toEqual(expected);
  });

  test("returns no windows for an empty config", () => {
    expect(windowsFromBilling({})).toEqual([]);
  });

  test("rounds and clamps percentages through the shared quota contract", () => {
    expect(
      windowsFromBilling({
        productUsage: [
          { product: "rounded", usagePercent: 1.4 },
          { product: "floor", usagePercent: -5 },
          { product: "ceiling", usagePercent: 140 },
        ],
      })
    ).toEqual([
      { id: "rounded", used_pct: 1 },
      { id: "floor", used_pct: 0 },
      { id: "ceiling", used_pct: 100 },
    ]);
  });
});

describe("Grok quota adapter registration", () => {
  test("declares the Grok subscription endpoint capability", () => {
    expect(grokQuotaAdapter.providerId).toBe("grok-subscription");
    expect(grokQuotaAdapter.capability().kind).toBe("endpoint");
  });

  test("is resolvable and reportable through the quota registry", () => {
    // Registration keeps `claudish quota grok` from misreporting a real feature as unknown.
    expect(resolveQuotaAdapter("grok-subscription")).toBe(grokQuotaAdapter);
    expect(reportableQuotaAdapters()).toContain(grokQuotaAdapter);
  });

  test("supports free polling as well as explicit reads", () => {
    // Grok's metadata GET spends no inference quota, unlike Codex's explicit probe.
    expect(typeof grokQuotaAdapter.poll).toBe("function");
    expect(typeof grokQuotaAdapter.fetchExplicit).toBe("function");
    expect(codexQuotaAdapter.poll).toBeUndefined();
    expect(typeof codexQuotaAdapter.fetchExplicit).toBe("function");
  });
});
