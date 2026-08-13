---
title: 在 Codex 中使用 GitHub Copilot 模型
description: 通过 opencodex 将 GitHub Copilot 模型路由到 Codex CLI、TUI、App 和 SDK。
---

本指南介绍如何通过 opencodex 的实验性 GitHub Copilot provider，在 Codex 中使用
GitHub Copilot 模型。

该 provider 使用基于账号的桥接链路：

- `ocx login github-copilot` 完成 GitHub device authorization flow。
- opencodex 将 GitHub 凭据交换为短期 Copilot API token。
- Copilot 模型以带命名空间的 ID 暴露给 Codex，例如
  `github-copilot/gpt-5.6-sol`。
- opencodex 负责 Copilot endpoint 路由、短期 token 刷新和响应转换。

该集成是实验性的非官方桥接，需要有效的 GitHub Copilot 订阅。GitHub 可能会更改或
撤销这条访问路径。请不要发送你不会提交给 GitHub Copilot 的机密内容。

## 快速开始

### 全新安装

安装 opencodex 并启动 proxy：

```bash
npm install -g .
ocx start
```

登录 GitHub Copilot：

```bash
ocx login github-copilot
```

按照 device flow 提示打开 GitHub 并批准登录。凭据会保存在 opencodex 的本地 OAuth
存储中，并在需要时自动刷新。不要把 GitHub token 或 Copilot token 复制到
`~/.codex/config.toml`。

刷新 Codex 模型目录：

```bash
ocx sync
```

`ocx start` 通常会自动执行同步。登录完成、provider 配置变化或 Copilot 权限变化后，
可以显式运行 `ocx sync`。

### 已有 opencodex 安装

如果只是添加 GitHub Copilot，不要重新运行 `ocx init`。直接登录并刷新：

```bash
ocx login github-copilot
ocx sync
```

该 provider 不会自动成为默认 provider。现有 provider 不会改变；选择 Copilot 模型时，
请显式使用 `github-copilot/` 前缀。

## 验证发现到的模型

查看当前 GitHub 账号可用的模型：

```bash
ocx models live --provider github-copilot --json
```

返回的 `namespaced` 值可以直接用于 Codex，例如：

```text
github-copilot/gpt-5.3-codex
github-copilot/gpt-5.6-sol
github-copilot/gpt-5.6-luna
```

具体列表取决于 GitHub 账号、Copilot 订阅和当前 Copilot 模型目录。也可以查看本地
proxy 暴露的 OpenAI-compatible 模型目录：

```bash
curl -fsS http://127.0.0.1:10100/v1/models \
  | jq -r '.data[]?.id | select(startswith("github-copilot/"))'
```

如果 proxy 使用非 loopback 绑定或启用了 API 认证，请使用配置的地址以及
[Codex 集成](/zh-cn/guides/codex-integration/)中说明的 `x-opencodex-api-key` header。

## 在 Codex 中选择 GitHub Copilot 模型

使用实时目录返回的准确模型 ID：

```bash
codex -m github-copilot/gpt-5.6-sol
codex -m github-copilot/gpt-5.6-luna
codex -m github-copilot/claude-sonnet-4
```

Codex 的本地 provider 配置仍然应该指向 opencodex：

```toml
openai_base_url = "http://127.0.0.1:10100/v1"
```

不要把这个地址替换成 `https://api.githubcopilot.com`。Copilot OAuth、token 交换、
模型路由、wire 选择和响应转换都由 proxy 负责。

在 Codex TUI 或 App 中，可以先运行 `ocx sync`，再从模型选择器中选择 Copilot 模型。
如果长期运行的 app-server 仍然持有旧目录，请在没有活动 turn 时刷新：

```bash
ocx sync --restart-codex
```

Codex CLI、TUI、App 和 SDK 通过 `CODEX_HOME` 共享同一份模型目录。

## Wire 和模型行为

GitHub Copilot provider 的基础 adapter 是 `openai-chat`，但对于需要 Responses 的
Copilot agent 流量，opencodex 会按模型使用对应的 Responses wire。当前 provider 配置的
GPT-5 系列模型可能不会发送到 `/chat/completions`。

请使用目录中的公开模型 ID，不要自行构造 Copilot wire-level 模型名或 token 参数。

## 可选的模型可见性控制

如果只想暴露指定的 Copilot 模型，可以设置 provider 级 allowlist。命令中的 ID 不带
`github-copilot/` 前缀：

```bash
ocx models selected github-copilot --set gpt-5.6-sol,gpt-5.6-luna
ocx sync
```

清除 allowlist，恢复当前账号发现到的模型：

```bash
ocx models selected github-copilot --clear
ocx sync
```

这些控制只影响 proxy 目录和 `/v1/models`，不会赋予 GitHub 账号额外的 Copilot 权限。

## 故障排查

### `Provider "github-copilot" is not configured`

执行：

```bash
ocx login github-copilot
ocx sync
ocx provider show github-copilot --json
```

### 没有发现 Copilot 模型

确认 device login 已完成，且 GitHub 账号拥有有效的 Copilot 订阅：

```bash
ocx account current github-copilot --json
ocx models live --provider github-copilot --json
```

如果 token 过期或权限被撤销，重新登录：

```bash
ocx login github-copilot
ocx sync
```

### 模型可见，但请求提示不可用

请使用刷新后的实时目录中存在的模型。静态 provider seed 只是回退元数据，不能赋予
GitHub 账号原本没有的 Copilot 权限。

### Codex Desktop 不显示模型

先刷新目录和长期运行的 app-server：

```bash
ocx sync --restart-codex
```

如果 CLI/TUI 可以使用，而 Desktop 不显示，Desktop renderer 可能正在应用自己的模型
allowlist。此时可以使用 CLI/TUI，或为新会话在 Codex home 中直接设置：

```toml
model = "github-copilot/gpt-5.6-sol"
```

## 从其他 Copilot proxy 迁移

opencodex 不会导入其他 proxy（例如 `copilot-api`）的凭据或 provider 状态。请停止旧
proxy，执行 `ocx login github-copilot`，并让客户端指向：

```text
http://127.0.0.1:10100/v1
```

两个 proxy 可能使用不同的本地凭据存储和模型映射。

## 为 Codex Desktop 启用裸模型别名

Codex Desktop 可能会过滤 `github-copilot/gpt-5.6-sol` 这类带命名空间的自定义 ID。
可以通过 provider 级选项试验使用看起来像原生模型的 ID：

```json
{
  "providers": {
    "github-copilot": {
      "githubCopilotBareModelAliases": true
    }
  }
}
```

然后刷新目录：

```bash
ocx sync
```

proxy 会额外发布 `gpt-5.6-sol` 等裸 ID，并将其映射回 GitHub Copilot。如果同时启用了
Cursor 的裸别名，相同的裸 ID 会产生歧义，此时 Cursor 优先。希望 GitHub Copilot 接管
重叠模型时，请关闭 `cursorBareModelAliases`。

## 这项集成不会做什么

- 不会把 GitHub Copilot 暴露成 Codex 原生 provider；Codex 实际连接的是 opencodex。
- 不会导入其他 proxy 的 Copilot token 或模型映射。
- 不会让每个静态列出的模型对每个 GitHub 账号都可用。
- 不会绕过 GitHub Copilot 的订阅和模型权限检查。

该 adapter 对 GitHub Copilot 的访问是非官方的；如果 GitHub 更改认证或 API 策略，
这条路径可能失效。
