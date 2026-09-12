# dsh-web-search-order

给 DSH 的 `web_search` 加一层有序降级：按你配置的顺序依次尝试多个搜索提供方，前一个不可用、报错、超时或返回空结果时自动换下一个。

它不实现搜索后端，也不碰凭据，只是把部署里已经注册到 `ctx.web` 的提供方（`exa`、`deepseek-official`……）串成一条链。模型侧的 `web_search`、agent preset、`web_fetch` 都不变。相当于 omp 的 `providers.webSearchOrder`。

```
web_search → ctx.web.search() → auto-fallback（本插件）
                                   ├─ order 里点名的优先，其余按注册顺序接上
                                   └─ 逐个尝试，第一个可用结果原样返回
```

## 安装

```powershell
dsh plugin --profile web add github:killcerr/dsh-web-search-order
```

包内自带 `cordis.patch.yml`，`dsh plugin` 会把它追加进该 profile 的 `dsh.profile.bundles`，启动时把 `web.searchProvider` 指到本插件并挂上路由行。重启 DSH 生效。

本地开发用路径装。`link:` 装法改完源码重启即可，不必重装：

```powershell
dsh plugin --profile web add C:\path\to\dsh-web-search-order
```

更新就是重跑同一条命令；要锁版本在 spec 后面加 `#v0.1.0`。

装好之后你只会碰到两个名字：包名 `dsh-web-search-order`，和 settings 里的小节名 `web-search-order`。provider id（`auto-fallback`）与 patch 行 id 由包内 patch 代填——只有手工接线时才需要自己写。

bundle 是按 profile 的，多个 profile 就各装一次。想让机器上所有 profile 一次性生效，可以改走机器级 patch（`$DSH_HOME/cordis.patch.yml` 里覆盖 `web` 行，再插入一行）——两种方式只能选一种，行 id 只能出现一次。

## 配置

写在 `~/.dsh/settings.yaml`，热生效，不用重启：

```yaml
web-search-order:
  order: [exa, deepseek-official]
  exclude: []
  timeoutSeconds: 20
  fallbackOnEmpty: true
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `order` | `[]` | 提供方 id，越靠前越优先。没点名到的按注册顺序接在后面；空数组就是注册顺序。没装（认不出）的 id 会被忽略，只提示一次。 |
| `exclude` | `[]` | 永不尝试，优先级高于 `order`。 |
| `timeoutSeconds` | `20` | 单次尝试的预算，见下节。 |
| `fallbackOnEmpty` | `true` | 既没有 sources 也没有回答文本时当作未命中，换下一个。设 `false` 则原样返回空结果。 |

同一组键也可以写在 patch 的行 `config` 里。优先级是 schema 默认值 < 行 config < `settings.yaml`。

## 超时怎么设

DSH 的 seam 没有 per-provider 超时，provider 只拿到一个 `AbortSignal`——所以这个预算是本插件自己加的，也只能由它自己保证：每次尝试同时等「预算到期」「调用方取消」「provider 返回」，谁先到算谁。provider 不理会 signal 也会按时失去这一轮，超时之后才返回的结果不会被采用。

两个方向都踩得到坑。太大，慢的首选提供方会吃掉整次工具调用的预算（`tool-web.searchTimeoutMs`，默认 30 秒），后面的提供方永远轮不到；太小，本来能成功的提供方会被掐死——实测一次 `deepseek-official` 搜索要 5 秒以上，设 5 秒会杀掉它，20 秒正常。

一个已知限制：超时只结束这一轮，不杀在途请求。遵守契约的 provider（官方的 deepseek / exa 都把 signal 传给了 `fetch`）会随之取消；自己写的、忽略 signal 的 adapter 会把请求跑完。

## 失败的时候

全链失败会抛一个 `WebError`，`code` 是 `WEB_PROVIDER_ERROR`；链上一个候选都没有时是 `WEB_PROVIDER_UNAVAILABLE`。消息逐条列出每个提供方的结果，provider 原文不截断，方便直接看到 401、缺 key 这类真原因：

```
every candidate web search provider behind "auto-fallback" failed:
- exa: error: WEB_PROVIDER_ERROR: Exa API error (HTTP 401)
- deepseek-official: timeout: timed out after 20000 ms
- brave: skipped (excluded)
```

调用方取消（工具超时、用户取消）会立刻抛 `WEB_ABORTED`，不会再去试下一个——语义是「这次调用取消了」，不是「这个提供方不行」。

## 排错

| 现象 | 处理 |
| --- | --- |
| 搜索还是走原来的提供方 | `web` 行的 `searchProvider` 没指到 `auto-fallback`。注意 profile 层会盖掉 bundle 层。 |
| `WEB_PROVIDER_CONFIGURED_MISSING: auto-fallback` | 这个 profile 没装本插件，或 insert 的 `name` 写错了。 |
| `... has no candidate provider to try (...)` | 链上一个候选都没有。消息里带着 `order` / `exclude` / 注册数量，照它看就行。 |
| 第二个提供方从不被尝试 | `timeoutSeconds` 太大，被外层 `tool-web.searchTimeoutMs` 提前掐断。 |
| 日志说 `does not expose a readable search-provider registry` | DSH 的 `ctx.web` 结构变了。本插件读 `ctx.web.searchProviders`（一个 `Map`），验证过的版本是 `@deepseek-ai/dsh-web@0.1.5-alpha.1`。 |

最后一条是本插件最脆的地方：`ctx.web` 没有公开的枚举 API，路由只能读那个字段。所以读不到时它安静地 fail-closed，而不是在搜索深处炸掉；`test/contract.test.js` 会在形状变化时直接失败。

## 开发

```powershell
pnpm install
npm test      # node --test，46 个用例，无网络
```

`lib/order.js` 是纯逻辑（排序 + 降级链，不 import DSH，错误构造器由调用方注入），`lib/registry.js` 是唯一读 `ctx.web.searchProviders` 的地方，`lib/provider.js` 是薄适配层，`lib/index.js` 是 cordis 插件本体。`test/seam.test.js`、`test/contract.test.js` 用 shipped 的 `WebRuntime` 和真实 cordis `Context` 跑，不 mock seam。

## 范围

只处理搜索，不处理 `fetch`；只排序已经装好的提供方。想内置后端、多密钥池、冷却熔断，看 [dsh-web-search-router](https://github.com/Kerberos255/dsh-web-search-router)、[dsh-web-search-aggregation](https://github.com/chendefine/dsh-web-search-aggregation)、[websearch-dsh](https://github.com/takasurazeem/websearch-dsh)——本插件不含这些，也还没有浏览器里的设置卡片。

## License

MIT
