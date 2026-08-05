import { describe, expect, test } from "bun:test";
import {
  type OpEntryValueKey,
  type OpSourceEntry,
  dedupeOpSourceEntries,
  groupEntriesByAccount,
  parseOpSourceEntries,
  parseOpSourceEntry,
  serializeOpSourceEntry,
} from "./op-source-entry.js";

describe("parseOpSourceEntry", () => {
  // Regression: legacy bare-string sources must remain readable without admitting blank entries.
  test("parses a bare string and rejects empty strings", () => {
    expect(parseOpSourceEntry("environment-id", "id")).toEqual({ value: "environment-id" });
    expect(parseOpSourceEntry("", "id")).toBeUndefined();
    expect(parseOpSourceEntry("   \t\n", "id")).toBeUndefined();
  });

  // Regression: object entries must retain their account after whitespace normalization.
  test("parses the value and trimmed account from the matching object key", () => {
    expect(
      parseOpSourceEntry({ id: "  environment-id  ", account: "  a.1password.com  " }, "id")
    ).toEqual({ value: "environment-id", account: "a.1password.com" });
  });

  // Regression: an import object must not be mistaken for an environment object.
  test("rejects an object carrying the wrong value key", () => {
    expect(
      parseOpSourceEntry({ ref: "op://Vault/Item/**", account: "a.1password.com" }, "id")
    ).toBeUndefined();
  });

  // Regression: one corrupt config member must not make the entire source list unreadable.
  test("drops junk members without throwing", () => {
    for (const junk of [null, 42, [], {}]) {
      expect(parseOpSourceEntry(junk, "id")).toBeUndefined();
    }

    expect(() =>
      parseOpSourceEntries(
        [null, 42, [], {}, { ref: "op://wrong/key" }, "environment-a", { id: "environment-b" }],
        "id"
      )
    ).not.toThrow();
    expect(
      parseOpSourceEntries(
        [null, 42, [], {}, { ref: "op://wrong/key" }, "environment-a", { id: "environment-b" }],
        "id"
      )
    ).toEqual([{ value: "environment-a" }, { value: "environment-b" }]);
  });
});

describe("serializeOpSourceEntry", () => {
  // Regression: touching legacy config must not churn undeclared entries into object form.
  test("keeps undeclared entries as bare strings and declared entries as keyed objects", () => {
    const bare = serializeOpSourceEntry({ value: "environment-id" }, "id");
    expect(typeof bare).toBe("string");
    expect(bare).toBe("environment-id");
    expect(
      serializeOpSourceEntry({ value: "op://Vault/Item/**", account: "b.1password.com" }, "ref")
    ).toEqual({ ref: "op://Vault/Item/**", account: "b.1password.com" });
  });

  // Regression: serialized entries must be lossless for both accepted config shapes.
  test("round-trips bare and account-declared entries", () => {
    const cases: Array<{ entry: OpSourceEntry; valueKey: OpEntryValueKey }> = [
      { entry: { value: "environment-id" }, valueKey: "id" },
      {
        entry: { value: "op://Vault/Item/**", account: "b.1password.com" },
        valueKey: "ref",
      },
    ];

    for (const { entry, valueKey } of cases) {
      expect(parseOpSourceEntry(serializeOpSourceEntry(entry, valueKey), valueKey)).toEqual(entry);
    }
  });
});

describe("source entry collections", () => {
  // Regression: lower-precedence duplicates must not replace the first entry's account binding.
  test("deduplicates by value with the first occurrence winning", () => {
    expect(
      dedupeOpSourceEntries([
        { value: "shared", account: "first.1password.com" },
        { value: "unique" },
        { value: "shared", account: "second.1password.com" },
        { value: "unique", account: "late.1password.com" },
      ])
    ).toEqual([{ value: "shared", account: "first.1password.com" }, { value: "unique" }]);
  });

  // Regression: authorization batches must preserve source membership and first-account order.
  test("groups resolved entries by account and collects undeclared entries", () => {
    const bFirst = { value: "b-first", account: "b.1password.com" };
    const aFirst = { value: "a-first", account: "a.1password.com" };
    const bSecond = { value: "b-second", account: "b.1password.com" };
    const undeclared = { value: "undeclared" };
    const aSecond = { value: "a-second", account: "a.1password.com" };

    const grouped = groupEntriesByAccount(
      [bFirst, aFirst, bSecond, undeclared, aSecond],
      (entry) => entry.account
    );

    expect(grouped.byAccount.size).toBe(2);
    expect([...grouped.byAccount.keys()]).toEqual(["b.1password.com", "a.1password.com"]);
    expect(grouped.byAccount.get("b.1password.com")).toEqual([bFirst, bSecond]);
    expect(grouped.byAccount.get("a.1password.com")).toEqual([aFirst, aSecond]);
    expect(grouped.undeclared).toEqual([undeclared]);
  });
});
