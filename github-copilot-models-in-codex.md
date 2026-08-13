---
title: Use GitHub Copilot Models in Codex
description: Route GitHub Copilot models through opencodex into Codex CLI, TUI, App, and SDK.
---

This guide explains how to use GitHub Copilot models from Codex through opencodex's
experimental GitHub Copilot provider.

The provider uses an account-backed bridge:

- `ocx login github-copilot` completes the GitHub device authorization flow.
- opencodex exchanges the GitHub credential for a short-lived Copilot API token.
- Copilot models are exposed to Codex with namespaced ids such as
  `github-copilot/gpt-5.6-sol`.
- opencodex routes the request through the Copilot-compatible endpoint and refreshes the
  short-lived token when needed.

This integration is experimental and unofficial. It requires an active GitHub Copilot
subscription, and GitHub may change or revoke this access path. Do not send confidential
material that you would not send to GitHub Copilot.

## Quick start

### Fresh installation

Install opencodex and start the proxy:

```bash
npm install -g .
ocx start
```

Authenticate GitHub Copilot:

```bash
ocx login github-copilot
```

Follow the device-flow instructions and approve the login at GitHub. The credential is stored
in opencodex's local OAuth store and is refreshed by opencodex when needed. Do not copy the
GitHub token or Copilot token into `~/.codex/config.toml`.

Refresh the Codex model catalog:

```bash
ocx sync
```

`ocx start` normally performs synchronization. Run `ocx sync` explicitly after login,
provider changes, or a Copilot entitlement change.

### Existing opencodex installation

Do not rerun `ocx init` just to add GitHub Copilot. Authenticate the provider and refresh:

```bash
ocx login github-copilot
ocx sync
```

The provider is not made the default provider automatically. Existing providers remain
unchanged; select a Copilot model explicitly with its `github-copilot/` prefix.

## Verify the discovered models

Inspect the account-filtered model list:

```bash
ocx models live --provider github-copilot --json
```

The returned `namespaced` values are suitable for Codex, for example:

```text
github-copilot/gpt-5.3-codex
github-copilot/gpt-5.6-sol
github-copilot/gpt-5.6-luna
```

The exact list depends on the GitHub account, Copilot subscription, and current Copilot
catalog. You can also inspect the OpenAI-compatible catalog exposed by the local proxy:

```bash
curl -fsS http://127.0.0.1:10100/v1/models \
  | jq -r '.data[]?.id | select(startswith("github-copilot/"))'
```

If the proxy uses a non-loopback bind or API authentication, use the configured host and
`x-opencodex-api-key` header described in [Codex Integration](/guides/codex-integration/).

## Select a GitHub Copilot model in Codex

Use the exact namespaced model id returned by live discovery:

```bash
codex -m github-copilot/gpt-5.6-sol
codex -m github-copilot/gpt-5.6-luna
codex -m github-copilot/claude-sonnet-4
```

The local Codex provider configuration should continue to point at opencodex:

```toml
openai_base_url = "http://127.0.0.1:10100/v1"
```

Do not replace this URL with `https://api.githubcopilot.com`. The proxy owns Copilot OAuth,
token exchange, model routing, wire selection, and response normalization.

In Codex TUI or App, run `ocx sync` and select the Copilot model if it appears in the picker.
If a long-lived app-server still has the old catalog, refresh it when no active turn is running:

```bash
ocx sync --restart-codex
```

The same catalog is shared by Codex CLI, TUI, App, and SDK through `CODEX_HOME`.

## Wire and model behavior

GitHub Copilot is exposed as an `openai-chat` provider, but opencodex uses per-model wire
defaults where Copilot agent traffic requires Responses. In particular, the GPT-5 family
models currently configured by the provider may use the Responses wire instead of
`/chat/completions`.

Use the public model id from the catalog. Do not construct Copilot wire-level model names
or token parameters manually.

## Optional model visibility controls

To expose only selected Copilot models, set a provider-local allowlist. The ids omit the
`github-copilot/` prefix:

```bash
ocx models selected github-copilot --set gpt-5.6-sol,gpt-5.6-luna
ocx sync
```

Clear the allowlist to restore the account-filtered discovery result:

```bash
ocx models selected github-copilot --clear
ocx sync
```

These controls affect the proxy catalog and `/v1/models`; they do not grant a model
entitlement to the GitHub account.

## Troubleshooting

### `Provider "github-copilot" is not configured`

Run:

```bash
ocx login github-copilot
ocx sync
ocx provider show github-copilot --json
```

### No Copilot models are discovered

Check that the device login completed and that the GitHub account has an active Copilot
subscription:

```bash
ocx account current github-copilot --json
ocx models live --provider github-copilot --json
```

If the token has expired or access was revoked, log in again:

```bash
ocx login github-copilot
ocx sync
```

### The model is visible but unavailable

Use a model present in the refreshed live result. Static provider seeds are only fallback
metadata and cannot grant Copilot access that the account does not have.

### Codex Desktop does not show the model

First refresh the catalog and the long-lived app-server:

```bash
ocx sync --restart-codex
```

If CLI/TUI can use the model but Desktop cannot show it, the Desktop renderer may apply
its own model allowlist. In that case use CLI/TUI or set the model directly in the Codex
home for a new session:

```toml
model = "github-copilot/gpt-5.6-sol"
```

## Migration from another Copilot proxy

opencodex does not import credentials or provider state from another proxy such as
`copilot-api`. Stop the old proxy, run `ocx login github-copilot`, and point clients at:

```text
http://127.0.0.1:10100/v1
```

The two proxies can use different local credential stores and different model mappings.

## Optional bare model aliases for Codex Desktop

Codex Desktop may filter namespaced custom ids such as `github-copilot/gpt-5.6-sol`. To
experiment with native-looking picker ids, enable this provider-local option:

```json
{
  "providers": {
    "github-copilot": {
      "githubCopilotBareModelAliases": true
    }
  }
}
```

Then refresh the catalog:

```bash
ocx sync
```

The proxy will publish ids such as `gpt-5.6-sol` and route them back to GitHub Copilot.
If Cursor bare aliases are enabled at the same time, identical bare ids are ambiguous and
Cursor keeps precedence. Disable `cursorBareModelAliases` when GitHub Copilot should own
the overlapping ids.

## What this integration does not do

- It does not expose GitHub Copilot as a native Codex provider; Codex talks to opencodex.
- It does not import another proxy's Copilot tokens or model mappings.
- It does not make every statically listed model available to every GitHub account.
- It does not bypass GitHub Copilot subscription or entitlement checks.

GitHub Copilot access through this adapter is unofficial and may stop working if GitHub
changes its authentication or API policies.
