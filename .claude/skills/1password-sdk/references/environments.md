# Reading 1Password Environments with `@1password/sdk` (JS/TS)

**Status: Beta.** A 1Password Environment is a named set of environment variables
managed in the desktop app, addressed by an opaque **Environment ID**. This is
distinct from `op://` secret references — Environments return a whole KEY=VALUE
set, not a single field.

## Requirement: install the beta SDK

The stable `@1password/sdk` does NOT include the `environments` API. Install the
beta:

```bash
bun add @1password/sdk@0.4.1-beta.1
```

(Go: `go get github.com/1password/onepassword-sdk-go@v0.4.1-beta.1`;
Python: `pip install onepassword-sdk==0.4.1b1`.)

## Read the variables

```ts
const res = await client.environments.getVariables("<environment-id>");
for (const env of res.variables) {
  console.log(`${env.name}=${env.value} (masked: ${env.masked})`);
  process.env[env.name] = env.value; // hydrate into the process if desired
}
```

## Response shape

```ts
interface GetVariablesResponse {
  variables: EnvironmentVariable[];
}
interface EnvironmentVariable {
  name: string;    // e.g. "DB_HOST"
  value: string;
  masked: boolean; // whether the value is hidden by default in the 1Password app
}
```

It's all-or-nothing: `getVariables` returns every variable in the Environment.
Filter client-side if you only want some (e.g. `res.variables.filter(v => v.name.endsWith("_API_KEY"))`).

## Getting the Environment ID

The ID is not discoverable via the SDK — copy it from the desktop app:

1. Open and unlock the 1Password desktop app.
2. Developer → **View Environments**.
3. **View environment** next to the one you want.
4. **Manage environment** → **Copy environment ID**.

## Notes

- Environment values are **masked by default** in the app UI; the `masked` flag
  reflects that. The SDK still returns the real `value` regardless of `masked`.
- Auth is the same as any other SDK operation: service-account token or
  `DesktopAuth` (see SKILL.md → Authenticate).
- If `client.environments` is `undefined`, you're on the stable SDK — switch to
  the beta version above.
