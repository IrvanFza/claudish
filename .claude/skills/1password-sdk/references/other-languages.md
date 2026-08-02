# 1Password SDK — Go & Python equivalents

The SDK has the same surface in Go and Python as the JS/TS skill body describes;
only the casing/idioms differ. Method-name map for cross-language work.

## Install

| Lang | Stable | Beta (environments) |
|------|--------|---------------------|
| Go | `go get github.com/1password/onepassword-sdk-go` | `…@v0.4.1-beta.1` |
| Python | `pip install onepassword-sdk` | `pip install onepassword-sdk==0.4.1b1` |

## Client init

```go
// Go
client, err := onepassword.NewClient(context.Background(),
    onepassword.WithServiceAccountToken(os.Getenv("OP_SERVICE_ACCOUNT_TOKEN")),
    onepassword.WithIntegrationInfo("my-app", "1.0.0"),
)
```

```python
# Python
from onepassword import Client  # or DesktopAuth
client = await Client.authenticate(
    auth=os.environ["OP_SERVICE_ACCOUNT_TOKEN"],
    integration_name="my-app",
    integration_version="1.0.0",
)
```

## Method map

| Operation | JS/TS | Go | Python |
|-----------|-------|-----|--------|
| Resolve one | `client.secrets.resolve(ref)` | `client.Secrets().Resolve(ctx, ref)` | `client.secrets.resolve(ref)` |
| Resolve many | `client.secrets.resolveAll(refs)` | `client.Secrets().ResolveAll(ctx, refs)` | `client.secrets.resolve_all(refs)` |
| Validate ref | `Secrets.validateSecretReference(ref)` | `onepassword.Secrets.ValidateSecretReference(ctx, ref)` | `Secrets.validate_secret_reference(ref)` |
| List vaults | `client.vaults.list()` | `client.Vaults().List(ctx)` | `client.vaults.list()` |
| List items | `client.items.list(vaultId)` | `client.Items().List(ctx, vaultID)` | `client.items.list(vault_id)` |
| Get item | `client.items.get(vaultId, itemId)` | `client.Items().Get(ctx, vaultID, itemID)` | `client.items.get(vault_id, item_id)` |
| Read environment (beta) | `client.environments.getVariables(id)` | `client.Environments().GetVariables(ctx, id)` | `client.environments.get_variables(id)` |

## Response field casing

- Batch resolve: JS `individualResponses` / `response.content.secret` ;
  Go `IndividualResponses` / `s.Content.Secret` ; Python `individual_responses` / `secret.content.secret`.
- Environment variable: `{name, value, masked}` (JS) / `{Name, Value, Masked}` (Go) /
  `{name, value, masked}` (Python).

Go is synchronous (takes a `context.Context`); JS and Python are async (`await`).

Official examples: [Go](https://github.com/1Password/onepassword-sdk-go/tree/main/example) ·
[JS](https://github.com/1Password/onepassword-sdk-js/tree/main/examples) ·
[Python](https://github.com/1Password/onepassword-sdk-python/tree/main/example).
