# dsh-web-search-order

给 DeepSeek Harness（DSH）的 `web_search` 加上 omp 的 `providers.webSearchOrder` 语义：**按顺序尝试多个搜索提供方，失败自动降级**。

它不实现任何新的搜索后端，而是把部署里**已经注册到 `ctx.web` 的搜索提供方**（例如 `exa`、`deepseek-official`）按你配置的顺序串成一条链。模型侧的 `web_search` 工具、agent preset、`web_fetch` 都不受影响。

```
web_search (dsh-tool-web)
  └─ ctx.web.search()   searchProvider = auto-fallback
       └─ AutoFallbackSearchProvider
            ├─ order 里的提供方优先，其余按注册顺序追加
            ├─ exclude / 自身 id 直接跳过
            └─ 依次尝试：不可用 → 跳过；报错 → 记录并继续；
               超时 → 记录并继续；空结果 → 记录并继续（可关）；
               第一个可用结果 → 原样返回（maxResults 仍由 seam 截断）
```

## 名字对照

同一个插件在不同层有不同标识符，各属一个命名空间——它们**不能互换**（把 settings 小节名写进 `searchProvider:` 是配不通的）。全仓库只有 **两个不同的字符串**：

| 名字 | 用作 | 谁在哪写 |
| --- | --- | --- |
| `dsh-web-search-order` | npm 包名 | 安装时：`dsh plugin --profile web add <spec>`、`dsh.profile.bundles` |
| `web-search-order` | cordis 插件 `name`（仅 loader 诊断）、settings 命名空间、patch 行 id —— 同一个字符串 | 调参时写在 `$DSH_HOME/settings.yaml` 的小节名；手写 `cordis.patch.yml` 时也用它 |
| `auto-fallback` | `ctx.web` 的 provider id（唯一与之不同的名字） | 手工接线时写 `searchProvider: auto-fallback` |

这与 shipped 的 `dsh-web-search-deepseek` 同构：那边包名/插件名/命名空间/行 id 都是 `web-search-deepseek`，只有 provider id 是 `deepseek-official`——注册表里的键必须能与别人并列区分。

用「一条命令」安装的话，包内 patch 已经替你填好 provider id 与行 id，你实际只会碰到包名和 settings 小节名。

## 与 omp 的对应关系

| omp | 本插件 |
| --- | --- |
| `providers.webSearchOrder: [a, b]` | `order: [a, b]`（未列出的提供方按注册顺序排在后面；空数组 = 保持注册顺序） |
| `providers.webSearchExclude: [c]` | `exclude: [c]`（被排除的提供方绝不尝试，包括在 `order` 里被点名） |
| `providers.webSearchTimeoutSeconds` | `timeoutSeconds`（**每次尝试**的预算，不是整条链的预算） |
| 自动落到下一个可用提供方 | 不可用 / 报错 / 超时 / 空结果都会落到下一个 |
| `/settings` 里的图形界面 | 本插件为 host-only：改 `$DSH_HOME/settings.yaml` 或行配置，热生效 |

## 安装

本包自带 `cordis.patch.yml` 并声明 `dsh.bundle.patch`，而 `dsh plugin` 会**自动**把这类依赖加进该 profile 的 `dsh.profile.bundles`（`dsh` 的 `reconcilePlugins()` 按已安装状态对账，不是靠命令行差分）。所以安装就是一条命令，**不需要手写任何 YAML**：

```powershell
dsh plugin --profile web add github:killcerr/dsh-web-search-order
```

它做三件事：pnpm 装包 → 自动把 `dsh-web-search-order` 追加进 `dsh.profile.bundles` → 启动时套用包内 patch（把 `web.searchProvider` 指到 `auto-fallback`，并插入 `web-search-order` 路由行）。**重启 DSH 生效。**

本地开发用路径即可，`link:` 装法改动源码后重启就能生效，不必重装：

```powershell
dsh plugin --profile web add C:\path\to\dsh-web-search-order
```

偏好（顺序 / 排除 / 超时）不要写在 patch 里，放 `$DSH_HOME/settings.yaml` —— 热生效、不用重启：

```yaml
web-search-order:
  order: [exa, deepseek-official]
  exclude: []
  timeoutSeconds: 20
  fallbackOnEmpty: true
```

> `auto-fallback` 是唯一被 seam 选中的提供方，它再按顺序调用其他提供方。包内 patch 已经替你把它选好；**手工接线时**必须自己写 `searchProvider: auto-fallback`，否则本插件不会参与任何搜索。

### 更新

```powershell
dsh plugin --profile web add github:killcerr/dsh-web-search-order   # 重新解析默认分支
```

要锁版本就在 spec 后面加 `#<commit>`。源码改动不会热加载（`patchReload` 只重载配置），装完重启 DSH。

### 想让所有 profile 都生效？

bundle 是**按 profile** 的——多个 profile 就各跑一次上面的命令。若你不想逐个安装，可改用机器级 patch：

1. 把包放到各 profile 都能解析的位置（`$DSH_HOME/profiles/node_modules/` 在 Node 的解析路径上，所有 profile 都会经过它）；
2. 在 `$DSH_HOME/cordis.patch.yml` 里写 `- id: web` 覆盖（`searchProvider: auto-fallback` + **`fetchProvider: http`**，patch 会整体替换该行 `config`）加一段 `- insert:` 插入 `web-search-order` 行。

> ⚠️ **两种方式二选一**：`web-search-order` 这个行 id 只能出现一次。已经用机器级 patch 装过，就先删掉那里的两段，再跑 `dsh plugin add`；反过来同理。

提供方挂载（例如 Exa 及其 key）始终是各 profile 自己的事，留在该 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: web-search-exa
      name: '@deepseek-ai/dsh-web-search-exa'
      config:
        apiKey: <your-exa-key>
```

> 若曾用 `dsh plugin` 装过又 `remove`，注意 pnpm 可能残留指向源码目录的 symlink；残留会让该 profile 继续解析到旧路径，需手动删掉该链接。

## 配置

配置按 seam 的常规顺序解析：schema 默认值 → 行配置（`cordis.patch.yml`）→ `$DSH_HOME/settings.yaml` 的 `web-search-order:` 小节（热生效，每次搜索重新读取）。

```yaml
# ~/.dsh/settings.yaml
web-search-order:
  order: [exa, deepseek-official]
  exclude: []
  timeoutSeconds: 20
  fallbackOnEmpty: true
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `order` | `[]` | 提供方 id，越靠前越优先。首次出现生效，重复项忽略；未列出的提供方按注册顺序追加；空数组保持注册顺序；未注册的 id 会被忽略（每个实例只告警一次，可能只是还没装）。 |
| `exclude` | `[]` | 永不尝试的提供方 id，优先级高于 `order`。 |
| `timeoutSeconds` | `20` | **单次尝试**的预算（≥1 秒，无上限）。这是路由器自己的策略——DSH seam 根本没有 per-provider 超时，provider 只拿到一个 `AbortSignal`。**实测**：一次真实的 `deepseek-official` 搜索要 5 秒以上（设成 5 秒时它会被自己的预算掐死），20 秒可正常返回。取值要同时满足两点：小于 `tool-web` 的 `searchTimeoutMs`（库默认 30 秒，本部署 60 秒），且 `timeoutSeconds × 候选数` 大致不超过它——否则第二、第三个提供方会被外层信号整体掐断。 |
| `fallbackOnEmpty` | `true` | 结果既没有 sources 也没有回答文本时，视为未命中并继续下一个。设为 `false` 则原样返回空结果。 |

## 行为细节

- **可用性**：先用提供方自己的 `available()` 做廉价本地判断（不联网），不可用或抛异常的都跳过。路由器自身 `available()` 恒为 `true`——它是个 meta-provider，所有失败细节由 `search()` 汇报；否则 seam 会用它通用的 `registered but unavailable` 顶掉我们逐条列出的诊断（shipped 的 `dsh-web-search-deepseek` 对凭据也是同样处理）。
- **降级条件**：报错、单次超时、空结果（可关）都会继续下一个；每次降级都会 `ctx.logger.warn` 一条带提供方 id 的记录。
- **但这些 warn 默认看不到**：本机这个 DSH 安装里没有任何 console exporter——cordis 的 `LoggerService` 只注册一个 1000 条的**内存环形缓冲**，没有包把它接到 stdout/stderr（全树 `grep exporter\(` 只有 cordis 自己那一处）。所以降级过程**只在最终的聚合错误里可见**（那是失败路径的返回值）。需要过程日志的话，DSH 原生的做法是记 session event：shipped 的 `dsh-web-search-deepseek` 就用 `web/deepseek-search-llm-request` 记录它发出的请求。
- **预算是路由器强制的，不是给 provider 的建议**：每次尝试同时 race 三件事——预算到期、调用方取消、provider 调用本身。因此 provider 忽略 `AbortSignal` 也会按时失去这一轮；超时之后才 resolve 的结果不会被当成成功；调用方取消立刻生效，不必等预算到期。
- **但超时只结束"这一轮"，不杀 in-flight 请求**：预算到期时我们会 `abort` 传给 provider 的信号——遵守契约的 provider（shipped 的 `dsh-web-search-deepseek` / `dsh-web-search-exa` 都把 signal 传给了 `fetch`）会随之取消 HTTP 请求；而忽略 signal 的 provider（自写 adapter）会继续把请求跑完。链上 N 个这样的 provider 最坏会叠 N 个并发搜索，外层 `tool-web.searchTimeoutMs` 也救不了它们。进程内没有干净的解法，这是已知限制。
- **取消**：调用方（工具超时、用户取消）中断时立即抛出 `WEB_ABORTED`，**不会**继续尝试下一个提供方。
- **全部失败**：抛一个 `WebError`，`code` 为 `WEB_PROVIDER_ERROR`；如果所有提供方在本地就不可用则为 `WEB_PROVIDER_UNAVAILABLE`。消息里逐行列出每个提供方的结果（含被跳过的）；每行压成单行但**不截断**——provider 原文里的操作指引会完整保留。`cause` 指向第一个错误：

  ```
  every candidate web search provider behind "auto-fallback" failed:
  - exa: error: WEB_PROVIDER_ERROR: Exa API error (HTTP 401)
  - deepseek-official: timeout: timed out after 20000 ms
  - brave: skipped (excluded)
  ```

- **无状态**：每次搜索独立快照配置和注册表；并发搜索互不影响。
- **热重载安全**：`ctx.web.registerSearchProvider` 本身就把注册绑到**调用方 fiber**（seam 注释原话 "disposed with the calling fiber"，`test/contract.test.js` 用真实 `Context` 断言了这一点），所以禁用/重载本插件不会残留 provider，也不会出现 `WEB_DUPLICATE_PROVIDER`；本插件**不加**额外包装——早先那层 `ctx.effect` 是多余的，会把同一个注册 dispose 两次。
- **不碰密钥**：本插件不做任何凭据解析，也不会往错误信息里添加密钥；提供方自己的错误文本按原样单行化但**不截断**。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 搜索仍走原来的提供方 | `web` 行的 `searchProvider` 没指到 `auto-fallback`（注意 profile 层覆盖 bundle 层）。 |
| `WEB_PROVIDER_CONFIGURED_MISSING: auto-fallback` | 插件没装进该 profile，或 `insert` 的 `name` 与实际包名不一致。 |
| 搜索报 `web search router "auto-fallback" has no candidate provider to try (...)` | 链上一个候选都没有：`exclude` 把提供方全排除了，或注册表里没有搜索提供方。消息里会列出 `order` / `exclude` / 注册数量。 |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | 本插件不会再产生它（`available()` 恒为 true）；若见到，说明该 profile 里跑的是旧代码，重启 DSH 即可。 |
| 日志出现 `does not expose a readable search-provider registry` | DSH 版本的 `ctx.web` 结构变了。本插件读取 `ctx.web.searchProviders`（一个 `Map`），当前验证版本为 `@deepseek-ai/dsh-web@0.1.5-alpha.1`。 |
| 第二个提供方从不被尝试 | `timeoutSeconds` 太大（或被外层 `tool-web.searchTimeoutMs` 提前掐断）。注意两个方向都会出问题：太大则慢提供方吃掉整次预算，太小则会把本来能成功的提供方掐死——实测 5 秒会掐死 `deepseek-official`，20 秒正常。 |

## 开发

```powershell
pnpm install
npm test        # node --test，46 个用例，无网络
```

- `lib/order.js`：纯逻辑（排序 + 降级链），不依赖 DSH，错误构造器由调用方注入，便于单测。
- `lib/registry.js`：唯一一处依赖 `ctx.web.searchProviders` 的地方，结构不符时**失败关闭**（返回 `undefined`）而不是在搜索深处炸掉。
- `lib/provider.js`：`AutoFallbackSearchProvider`，薄适配层。
- `lib/index.js`：cordis 插件（`Config` / `apply` / `inject` / `name`）。
- `test/seam.test.js`：用 shipped 的 `WebRuntime` + 真实 cordis `Context` 跑端到端（选择、`available()`、错误码、`maxResults` 截断、取消），不经过任何 mock seam。

## 端到端验证（隔离的 headless 会话）

不改动正在运行的 host，用一个独立 `DSH_HOME` 起一次性会话，跑真实 `web_search`：

```powershell
$env:DSH_HOME = "C:\path\to\dsh-web-search-order\.dsh-test"
$env:DSH_TELEMETRY_DISABLED = "1"; $env:DSH_PERMISSION_MODE = "danger-full-access"

# 1) 从 shipped 模板创建 headless profile（不会继承任何本机 profile 状态）
dsh --profile srtest --from-default-profile headless -h

# 2) 把插件和 Exa 提供方链接进该 profile（本地开发用 junction 即可）
$nm = "$env:DSH_HOME\profiles\node_modules"
New-Item -ItemType Junction -Path "$nm\dsh-web-search-order"        -Target <插件目录>
New-Item -ItemType Junction -Path "$nm\@deepseek-ai\dsh-web-search-exa" -Target <exa 包目录>

# 3) 写 profiles\srtest\cordis.patch.yml：web 行 searchProvider 指到 auto-fallback，
#    并插入 web-search-exa 与 web-search-order 两行
# 4) 提供凭据（headless 会话也要 LLM 的 key）
Copy-Item "$env:USERPROFILE\.dsh\.credentials.yaml" "$env:DSH_HOME\.credentials.yaml"

# 5) 跑真实会话
dsh --profile srtest "Call the web_search tool exactly once with the query '<query>'. Then reply with only the source URLs it returned, one per line."
```

三种配置分别验证：`exclude: []` 正常出结果；`exclude: [exa, deepseek-official]` 得到路由器自己的诊断；把 Exa 的 `baseURL` 指向不可达地址则自动落到 `deepseek-official`。

> ⚠️ 用完**不要**直接 `Remove-Item -Recurse`。`profiles/node_modules` 里是对全局 dsh 安装的 junction（本机约 500 个），递归删除会穿透链接删掉真身。先逐层把 reparse point 用 `[System.IO.Directory]::Delete($link, $false)` 删掉，再删目录。

## 说明

- 只处理搜索，不处理 `fetch`。
- 只排序**已安装**的搜索提供方；本插件不内置任何后端。想要内置多后端/多密钥池的方案，可参考 [Kerberos255/dsh-web-search-router](https://github.com/Kerberos255/dsh-web-search-router)、[chendefine/dsh-web-search-aggregation](https://github.com/chendefine/dsh-web-search-aggregation)、[takasurazeem/websearch-dsh](https://github.com/takasurazeem/websearch-dsh)。
- 当前不含：冷却/熔断、密钥轮换、浏览器设置卡片。
