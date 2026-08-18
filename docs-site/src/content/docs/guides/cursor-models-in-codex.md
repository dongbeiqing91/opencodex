---
title: Use Cursor Models in Codex
description: Route models available to your Cursor account through opencodex into Codex CLI, TUI, App, and SDK.
---

This guide explains how to use models available to a Cursor account from Codex through
opencodex's experimental Cursor adapter.

This is an account-backed bridge, not a way to copy Cursor Desktop's local settings into Codex:

- `ocx login cursor` authenticates the Cursor account with a browser-based PKCE flow.
- opencodex asks Cursor's `GetUsableModels` RPC which models that account can use.
- Codex sees those models as namespaced ids such as `cursor/claude-sonnet-5`.
- opencodex translates Codex's Responses requests to Cursor's protocol and translates the result
  back for Codex.

The adapter is experimental and unofficial. Use it only where your Cursor account and the
applicable Cursor terms permit this access path. A model shown in a fallback catalog is not proof
that the account is entitled to use it.

If the network cannot carry Cursor's HTTP/2 agent stream, set
`providers.cursor.cursorTransport` to `"http1-sse"`. This uses Cursor's HTTP/1.1 `RunSSE`
response stream and ordered `BidiAppend` requests. It does not enable polling or automatic
transport fallback.

## Effort tiers and live discovery

Cursor model ids encode the reasoning effort as a suffix (`claude-4.6-opus-high`). The tiers an
account can use differ per model and per subscription. opencodex derives the Codex picker ladder
from the account's live `GetUsableModels` response, so the catalog only advertises effort tiers
the account can actually use. A model whose family supports `max` but whose account only
exposes `high` will show only `high` in Codex; selecting `max` would otherwise make Cursor
reject the turn with `failed_precondition` or `not_found`.

When live discovery is unavailable (logged out, network blocked, or discovery cooling down),
opencodex falls back to the static registry ladder and keeps the full tier set so the catalog
is not empty. The picker narrows again once live discovery succeeds.

## Transport diagnostics

Provider debug logging (`ocx debug provider on` or `OCX_DEBUG=1`) distinguishes normal
teardown from real failures on the HTTP/1.1 wire:

- `post-terminal-close` and `stream-cancel-expected` are benign: the turn completed
  (`turnEnded` was received) and the connection reset that followed is noise from the
  HTTP/1.1 teardown, not a failure.
- `turn-failed` without a preceding `turnEnded` is a genuine mid-turn truncation.
- `failed_precondition` or `not_found` from the Cursor Connect trailer means the model
  or effort tier is not available to the account; switch to a tier the account exposes.

## Quick start

### Fresh installation

Install opencodex, then run the setup wizard:

```bash
npm install -g @bitkyc08/opencodex
ocx init
```

In the wizard:

1. Select **Cursor (experimental)**.
2. Keep the default upstream URL, `https://api2.cursor.sh`.
3. Keep the default model (`auto`) unless you have a preferred model.
4. Allow Codex integration when prompted.

The wizard writes the provider configuration but does not complete the Cursor login. Authenticate
the account separately:

```bash
ocx login cursor
```

Approve the login in the browser. Credentials are stored in opencodex's local OAuth store and are
refreshed by opencodex when needed; do not copy Cursor cookies, session files, or access tokens into
Codex configuration.

Start the proxy and refresh the Codex catalog:

```bash
ocx start
ocx sync
```

`ocx start` normally performs the sync itself. Running `ocx sync` explicitly is useful after a
login, model-entitlement change, or provider configuration change.

### Existing opencodex installation

Do not rerun `ocx init` just to add Cursor: `ocx init` writes a fresh provider configuration. On an
existing installation, run:

```bash
ocx login cursor
ocx start       # or ocx sync if the proxy is already running
```

The login command creates or refreshes the `cursor` provider entry. It does not make Cursor the
default provider, so existing providers remain unchanged. Use an explicit `cursor/<model>` id when
you want to select Cursor for one request.

## Verify the discovered models

The static provider list is only a seed. The authoritative Cursor-specific discovery path is the
authenticated `GetUsableModels` RPC, not a generic `GET /models` request.

Inspect the live catalog exposed by the running proxy:

```bash
ocx models live --provider cursor --json
```

Each returned row has a `namespaced` value suitable for Codex, for example:

```text
cursor/auto
cursor/claude-sonnet-5
cursor/gpt-5.6-sol
```

The exact list depends on the signed-in Cursor account and can change with the account plan or
Cursor's server-side catalog. You can also inspect the complete OpenAI-compatible catalog on the
default loopback listener:

```bash
curl -fsS http://127.0.0.1:10100/v1/models \
  | jq -r '.data[]?.id | select(startswith("cursor/"))'
```

If the proxy uses a non-loopback bind or API authentication, use the host and the configured
`x-opencodex-api-key` header described in [Codex Integration](/guides/codex-integration/).

## Select a Cursor model in Codex

Use the exact `cursor/<model>` id returned by the live catalog:

```bash
codex -m cursor/claude-sonnet-5
codex -m cursor/gpt-5.6-sol
```

Cursor Router choices are exposed as separate Codex model ids because Codex cannot express
Cursor-specific optimization parameters in a model picker:

| Codex model id | Cursor Router mode |
| --- | --- |
| `cursor/auto` | Team or account default |
| `cursor/auto-cost` | Cost optimization |
| `cursor/auto-balance` | Balanced optimization |
| `cursor/auto-intelligence` | Intelligence optimization |

In Codex TUI or App, run `ocx sync` and choose the routed model from the model picker. If the
picker still shows an old list, restart the long-lived Codex app-server:

```bash
ocx sync --restart-codex
```

The same catalog is shared through `CODEX_HOME` by Codex CLI, TUI, App, and SDK. On the default
loopback setup, opencodex points Codex's built-in `openai` provider at the local proxy:

```toml
openai_base_url = "http://127.0.0.1:10100/v1"
```

Do not replace this with `https://api2.cursor.sh`. Codex sends the Responses API, while the Cursor
adapter owns Cursor authentication, request conversion, streaming, model-id normalization, and
error translation.

## Optional model visibility controls

By default, all models returned by Cursor discovery are eligible for the Codex catalog. To expose
only a selected subset, set a provider-local allowlist. The ids in this command omit the `cursor/`
prefix because they are provider model ids:

```bash
ocx models selected cursor --set claude-sonnet-5,gpt-5.6-sol
ocx sync
```

Clear the allowlist to expose the discovered set again:

```bash
ocx models selected cursor --clear
ocx sync
```

You can hide an individual routed id with the global visibility control:

```bash
ocx models disable cursor/gpt-5.6-sol
ocx models enable cursor/gpt-5.6-sol
```

These controls affect the catalog and `/v1/models`; they do not turn a model entitlement on or
off at Cursor.

## Reasoning and model ids

Some Cursor models are exposed to Codex with reasoning-effort choices. Select the base
`cursor/<model>` id; opencodex maps the chosen effort to Cursor's wire representation. For example,
Cursor may advertise effort-suffixed wire ids for Kimi K3, while Codex uses the stable
`cursor/kimi-k3` picker id.

Grok 4.5 Fast is another adapter-specific case: Codex uses `cursor/grok-4.5-fast`, and opencodex
sends Cursor's `grok-4.5` model together with the `fast` request parameter. You normally do not
need to construct these wire-level ids yourself.

## Codex Desktop troubleshooting

### The model is in `ocx models live` but not in the picker

Check the layers in order:

1. Run `ocx sync --restart-codex` to refresh the on-disk catalog and restart a long-lived
   `app-server`.
2. Confirm that `ocx models live --provider cursor --json` contains the model.
3. If CLI/TUI can use the model but Codex Desktop cannot show it, the Desktop remote-server
   renderer may be applying its own native-only `available_models` allowlist. This is a Codex-side
   limitation; opencodex cannot change that renderer policy. Use CLI/TUI or set the model directly
   in the remote Codex home:

   ```toml
   model = "cursor/claude-sonnet-5"
   ```

   The picker may display `Custom` even though requests use the configured routed model. See
   [Codex App Model Picker](/guides/codex-app-models/) for the broader Desktop limitation.

### The model is visible but the request says it is unavailable

This usually means the row came from a static seed or stale cache, while the current Cursor
account cannot use that model. Reauthenticate and refresh:

```bash
ocx login cursor
ocx sync
ocx models live --provider cursor --json
```

Use a model present in the refreshed live result. The catalog cannot grant Cursor access that the
account does not have.

### Cursor-native local tools are unavailable

That is the default safety behavior. Codex continues to use its own `exec_command`, `apply_patch`,
and other tools under Codex's approval and sandbox policy. The Cursor adapter rejects Cursor-native
`read`, `write`, `delete`, `ls`, `grep`, `shell`, and `fetch` execution unless the operator
explicitly opts into trusted local execution with `nativeLocalExec: "on"` in the `providers.cursor`
object. Enabling it bypasses Codex's normal approval and sandbox semantics and is not required to
use Cursor models, so leave it `"off"` unless you fully understand the local security boundary.

The complete provider example and the local-execution policy are in the [Provider Configuration
reference](/reference/configuration/providers/#cursor-provider-adapter-cursor).

## What this integration does not do

- It does not import Cursor Desktop's model-picker settings or local cache.
- It does not expose Cursor directly as a native Codex provider; Codex talks to opencodex locally.
- It does not make every statically listed model usable by every Cursor account.
- It does not enable Cursor-native local execution, MCP, computer use, or screen recording by
  default. Those capabilities are separate adapter controls.

For the underlying catalog and injection behavior, see [Codex Integration](/guides/codex-integration/)
and [Model Routing](/guides/model-routing/).
