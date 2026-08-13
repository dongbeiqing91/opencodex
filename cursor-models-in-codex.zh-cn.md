---
title: 在 Codex 中使用 Cursor 模型
description: 通过 opencodex 将 Cursor 账户可用的模型路由到 Codex CLI、TUI、App 和 SDK。
---

本指南介绍如何通过 opencodex 的实验性 Cursor adapter，在 Codex 中使用 Cursor 账户可用的模型。

这是一条基于账户的桥接链路，不是把 Cursor Desktop 的本地设置复制到 Codex：

- `ocx login cursor` 通过浏览器中的 PKCE 流程认证 Cursor 账户。
- opencodex 调用 Cursor 的 `GetUsableModels` RPC，查询该账户实际可以使用的模型。
- Codex 会看到带命名空间的模型 id，例如 `cursor/claude-sonnet-5`。
- opencodex 将 Codex 的 Responses 请求转换为 Cursor 协议，再把结果转换回 Codex。

该 adapter 仍处于实验阶段，且不是 Cursor 官方集成。请确认你的 Cursor 账户以及适用的 Cursor 条款允许使用这条访问路径。回退目录中出现某个模型，并不代表你的账户获得了该模型的使用权限。

如果当前网络无法承载 Cursor 的 HTTP/2 agent 流，可以在 `providers.cursor` 中显式设置
`cursorTransport: "http1-sse"`。该模式使用 Cursor 的 HTTP/1.1 `RunSSE` 响应流和有序的
`BidiAppend` 请求；不会启用轮询，也不会自动回退到其他传输方式。

## 快速开始

### 全新安装

安装 opencodex，然后运行初始化向导：

```bash
npm install -g .
ocx init
```

在向导中：

1. 选择 **Cursor (experimental)**。
2. 保留默认上游 URL：`https://api2.cursor.sh`。
3. 如果没有特别偏好，保留默认模型 `auto`。
4. 在出现提示时允许启用 Codex 集成。

向导会写入 provider 配置，但不会完成 Cursor 登录。请单独进行认证：

```bash
ocx login cursor
```

在浏览器中批准登录。凭据会保存在 opencodex 的本地 OAuth 存储中，并由 opencodex 在需要时刷新；不要把 Cursor cookie、会话文件或 access token 复制到 Codex 配置中。

启动 proxy 并刷新 Codex 模型目录：

```bash
ocx start
ocx sync
```

`ocx start` 通常会自动执行 sync。登录完成、账户模型权限变化或 provider 配置变化后，也可以显式运行 `ocx sync`。

### 已有 opencodex 安装

如果只是想添加 Cursor，不要重新运行 `ocx init`：`ocx init` 会写入一份新的 provider 配置。已有安装直接运行：

```bash
ocx login cursor
ocx start       # proxy 已运行时也可以使用 ocx sync
```

登录命令会创建或刷新 `cursor` provider，但不会把 Cursor 设为默认 provider，因此现有 provider 不会改变。只想在某次请求中使用 Cursor 时，请显式选择 `cursor/<model>` id。

## 验证已发现的模型

静态 provider 列表只是一份种子数据。Cursor 的权威发现路径是经过认证的 `GetUsableModels` RPC，而不是通用的 `GET /models` 请求。

查看运行中 proxy 暴露的实时目录：

```bash
ocx models live --provider cursor --json
```

每一行都会包含可供 Codex 使用的 `namespaced` 值，例如：

```text
cursor/auto
cursor/claude-sonnet-5
cursor/gpt-5.6-sol
```

具体列表取决于当前登录的 Cursor 账户，并可能随账户套餐或 Cursor 服务端目录变化。你也可以在默认 loopback listener 上查看完整的 OpenAI-compatible 模型目录：

```bash
curl -fsS http://127.0.0.1:10100/v1/models \
  | jq -r '.data[]?.id | select(startswith("cursor/"))'
```

如果 proxy 使用非 loopback 绑定或 API 认证，请使用对应主机地址，并按 [Codex 集成](/zh-cn/guides/codex-integration/) 的说明发送 `x-opencodex-api-key` header。

## 在 Codex 中选择 Cursor 模型

使用实时目录返回的准确 `cursor/<model>` id：

```bash
codex -m cursor/claude-sonnet-5
codex -m cursor/gpt-5.6-sol
```

由于 Codex 的模型选择器无法表达 Cursor 专用的优化参数，Cursor Router 选项会以独立的 Codex 模型 id 暴露：

| Codex 模型 id | Cursor Router 模式 |
| --- | --- |
| `cursor/auto` | 团队或账户默认模式 |
| `cursor/auto-cost` | 成本优化 |
| `cursor/auto-balance` | 平衡优化 |
| `cursor/auto-intelligence` | 智能优化 |

在 Codex TUI 或 App 中，运行 `ocx sync`，然后从模型选择器中选择路由模型。如果选择器仍显示旧列表，可以重启长期运行的 Codex app-server：

```bash
ocx sync --restart-codex
```

Codex CLI、TUI、App 和 SDK 通过 `CODEX_HOME` 共享同一份模型目录。在默认 loopback 配置下，opencodex 会把 Codex 内置的 `openai` provider 指向本地 proxy：

```toml
openai_base_url = "http://127.0.0.1:10100/v1"
```

不要把它替换为 `https://api2.cursor.sh`。Codex 发送的是 Responses API；Cursor adapter 负责 Cursor 认证、请求转换、流式响应、模型 id 规范化和错误转换。

## 可选的模型可见性控制

默认情况下，Cursor 实时发现返回的所有模型都可以进入 Codex 目录。如果只想暴露指定模型，可以设置 provider 级 allowlist。下面命令中的 id 不带 `cursor/` 前缀，因为它们是 provider 内部的模型 id：

```bash
ocx models selected cursor --set claude-sonnet-5,gpt-5.6-sol
ocx sync
```

清除 allowlist，恢复暴露实时发现的全部模型：

```bash
ocx models selected cursor --clear
ocx sync
```

也可以通过全局可见性控制隐藏某个路由 id：

```bash
ocx models disable cursor/gpt-5.6-sol
ocx models enable cursor/gpt-5.6-sol
```

这些控制只影响模型目录和 `/v1/models`，不会改变 Cursor 账户本身的模型权限。

## 推理档位和模型 id

部分 Cursor 模型会向 Codex 暴露 reasoning effort 选项。请选择基础的 `cursor/<model>` id，opencodex 会把选择的 effort 映射到 Cursor 的 wire 表示。例如，Cursor 可能为 Kimi K3 暴露带 effort 后缀的 wire id，而 Codex 选择器仍使用稳定的 `cursor/kimi-k3` id。

Grok 4.5 Fast 也是一个 adapter 专用场景：Codex 使用 `cursor/grok-4.5-fast`，opencodex 则发送 Cursor 的 `grok-4.5` 模型，并额外发送 `fast` 请求参数。通常不需要自行构造这些 wire-level id。

## Codex Desktop 故障排查

### `ocx models live` 中有模型，但选择器中没有

按以下顺序检查：

1. 运行 `ocx sync --restart-codex`，刷新磁盘上的目录并重启长期运行的 `app-server`。
2. 确认 `ocx models live --provider cursor --json` 的结果中包含该模型。
3. 如果 CLI/TUI 可以使用该模型，但 Codex Desktop 不显示，Desktop 的远程服务器 renderer 可能正在应用仅允许原生模型的 `available_models` allowlist。这是 Codex 侧的限制，opencodex 无法修改该 renderer 策略。此时可以使用 CLI/TUI，或直接在远程 Codex home 中设置模型：

   ```toml
   model = "cursor/claude-sonnet-5"
   ```

   选择器可能显示为 `Custom`，但请求仍会使用配置的路由模型。更完整的 Desktop 限制说明请参阅 [Codex App 模型选择器](/zh-cn/guides/codex-app-models/)。

### 模型可见，但请求提示模型不可用

这通常表示该行来自静态种子或旧缓存，而当前 Cursor 账户无法使用该模型。重新认证并刷新：

```bash
ocx login cursor
ocx sync
ocx models live --provider cursor --json
```

请使用刷新后的实时结果中存在的模型。模型目录不能赋予 Cursor 账户本来没有的权限。

### Cursor 原生本地工具不可用

这是默认的安全行为。Codex 继续使用自己的 `exec_command`、`apply_patch` 等工具，并遵守 Codex 的批准和 sandbox 策略。除非 operator 在 `providers.cursor` 对象中明确设置 `nativeLocalExec: "on"`，否则 Cursor adapter 会拒绝 Cursor 原生的 `read`、`write`、`delete`、`ls`、`grep`、`shell` 和 `fetch` 执行。启用后会绕过 Codex 原有的批准和 sandbox 语义，不是使用 Cursor 模型的必要条件；除非完全理解这条本地安全边界，否则请保持为 `"off"`。

完整 provider 示例和本地执行策略请参阅[Provider 配置参考](/zh-cn/reference/configuration/providers/#cursor-provider-adapter-cursor)。

## 这项集成不会做什么

- 不会导入 Cursor Desktop 的模型选择器设置或本地缓存。
- 不会把 Cursor 暴露成 Codex 的原生 provider；Codex 实际上是通过本地 proxy 与 opencodex 通信。
- 不会让每个静态列出的模型都对每个 Cursor 账户可用。
- 默认不会启用 Cursor 原生本地执行、MCP、computer use 或屏幕录制；这些能力由独立的 adapter 控制项管理。

关于底层模型目录和注入行为，请参阅 [Codex 集成](/zh-cn/guides/codex-integration/) 和 [模型路由](/zh-cn/guides/model-routing/)。
