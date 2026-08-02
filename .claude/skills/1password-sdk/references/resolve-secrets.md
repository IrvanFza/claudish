# Resolving secrets with `@1password/sdk` (JS/TS)

Full detail for `client.secrets.resolve`, `resolveAll`, and reference validation.
Assumes an initialized `client` (see SKILL.md → Authenticate).

## Secret reference syntax

```
op://<vault>/<item>/[section/]<field>[?attribute=<value>]
```

- `<vault>`, `<item>`, `<field>` may be **names** OR **unique IDs** (26 alphanumeric chars).
- `[section/]` is optional — include it only when the field lives in a named section.
- Use **IDs** when names are ambiguous (duplicate vault/item/field names) or for
  stability. IDs only change when an item moves between vaults. Get IDs via
  `vaults.list()` / `items.list()` (see `glob-discovery.md`).
- Names containing `/` or other special characters: use the ID instead.

## Resolve a single secret

```ts
const secret = await client.secrets.resolve("op://Vault/Item/credential");
console.log(secret); // the plaintext value (string)
```

Returns the field's value as a `string`. Throws if the reference can't be
resolved (vault/item/field not found, ambiguous, auth failure).

## Resolve many at once — prefer this for >1

`resolveAll` makes a single round-trip and gives **per-reference** errors, so one
bad reference doesn't fail the whole batch:

```ts
try {
  const secrets = await client.secrets.resolveAll([
    "op://Vault/Item/username",
    "op://Vault/Item/password",
  ]);

  for (const [ref, response] of Object.entries(secrets.individualResponses)) {
    if (response.error) {
      console.error(`Error resolving ${ref}:`, response.error);
      continue;
    }
    console.log(response.content.secret);
  }
} catch (error) {
  // Thrown only for whole-batch failures (e.g. auth). Per-ref errors are in
  // individualResponses[ref].error, NOT thrown.
  console.error("Unexpected error:", error);
}
```

### Response shapes

```ts
interface ResolveAllResponse {
  // keyed by the INPUT reference string
  individualResponses: Record<string, Response<ResolvedReference, ResolveReferenceError>>;
}
interface Response<T, E> { content?: T; error?: E; }
interface ResolvedReference { secret: string; itemId: string; vaultId: string; }
```

So each entry is either `{ content: { secret, itemId, vaultId } }` on success or
`{ error: {...} }` on failure. `ResolveReferenceError` is a discriminated union
with variants like `vaultNotFound`, `itemNotFound`, `fieldNotFound`,
`tooManyVaults`, `tooManyItems`, `tooManyMatchingFields` — useful for precise
error messages.

## Validate a reference (no network call)

Check syntax before resolving — catches typos without a round-trip:

```ts
import { Secrets } from "@1password/sdk";

try {
  Secrets.validateSecretReference("op://Vault/Item/field");
} catch (error) {
  console.error("Bad reference:", error); // describes the syntax problem
}
```

This is a **static** method (call on `Secrets`, not on a client instance) and
validates format only — it does NOT check that the vault/item/field exists.

## Query parameters

Append to the reference to retrieve special attributes:

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `?attribute=otp` | one-time password (TOTP) | `op://dev/gitlab/one-time password?attribute=otp` |
| `?ssh-format=openssh` | SSH key in OpenSSH format | `op://vault/ssh-item/private key?ssh-format=openssh` |

## Supported field types

Resolution works on these 1Password field types: `Concealed` (passwords/API
keys/PINs), `Text`, `Email`, `Phone`, `Url`, `Date`, `MonthYear`,
`CreditCardNumber`, `CreditCardType`, `Address`, `Notes`, `Menu`, `Totp`,
`SSHKey`, `Reference`.

## Security hygiene

- Keep resolved values **in-memory only** — never write to disk, never log them.
- If you must log for debugging, mask: show the first ~4 chars + `…`, never the full value.
- `OP_SERVICE_ACCOUNT_TOKEN` is a full-decryption credential — read it from the
  ambient env at call time; never echo, persist, or commit it.
