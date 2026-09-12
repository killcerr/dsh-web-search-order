# dsh-web-search-order

[中文](README.md)

Ordered fallback for DSH's `web_search`: providers are tried in the order you configure, and one that is unavailable, errors, exceeds its budget, or returns nothing usable hands the turn to the next.

It implements no search backend and touches no credentials. It only chains the providers a deployment has already registered with `ctx.web` (`exa`, `deepseek-official`, ...). The model-facing `web_search` tool, agent presets, and `web_fetch` are untouched. This is the DSH counterpart of omp's `providers.webSearchOrder`.

```
web_search → ctx.web.search() → auto-fallback (this plugin)
                                   ├─ providers named by `order` first, then registry order
                                   └─ tried in turn; the first usable result is returned as-is
```

## Install

```powershell
dsh plugin --profile web add github:killcerr/dsh-web-search-order
```

The package ships its own `cordis.patch.yml`, and `dsh plugin` appends it to the profile's `dsh.profile.bundles`. At boot that patch points `web.searchProvider` at this plugin and mounts the router row. Restart DSH to take effect.

For local development, install from a path. `link:` means source edits need a restart, not a reinstall:

```powershell
dsh plugin --profile web add C:\path\to\dsh-web-search-order
```

Updating is the same command again; pin a version by appending `#v0.1.0`.

You will only ever type two names: the package `dsh-web-search-order` and the settings section `web-search-order`. The provider id (`auto-fallback`) and the patch row id are filled in by the bundled patch — you write them by hand only if you wire the plugin up manually.

Bundles are per profile, so install once per profile. To cover every profile on the machine at once instead, use a machine-level patch (`$DSH_HOME/cordis.patch.yml`: override the `web` row, then insert the router row). Pick one or the other — the row id may appear only once.

## Configuration

In `~/.dsh/settings.yaml`. Changes apply live, with no restart:

```yaml
web-search-order:
  order: [exa, deepseek-official]
  exclude: []
  timeoutSeconds: 20
  fallbackOnEmpty: true
```

| Key | Default | |
| --- | --- | --- |
| `order` | `[]` | Provider ids, most preferred first. Providers you leave out follow in registry order; an empty list is registry order. Ids that are not installed are ignored, with a one-time note. |
| `exclude` | `[]` | Never tried, and this outranks `order`. |
| `timeoutSeconds` | `20` | Per-attempt budget; see below. |
| `fallbackOnEmpty` | `true` | A result with neither sources nor answer text counts as a miss and hands over to the next provider. Set `false` to return the empty result as-is. |

The same keys can go in the row's `config` in a patch. Precedence is schema defaults < row config < `settings.yaml`.

## Sizing the timeout

DSH's seam has no per-provider timeout: a provider is handed an `AbortSignal` and nothing else. So this budget is the plugin's own, and the plugin is the only thing that can guarantee it. Each attempt waits on the deadline, on caller cancellation, and on the provider itself, and whichever arrives first wins. A provider that ignores the signal still loses its turn on time, and a result that lands after the deadline is not used.

Both directions bite. Too large, and a slow first provider eats the whole tool-call budget (`tool-web.searchTimeoutMs`, 30 s by default), so the later providers never get a turn. Too small, and you kill providers that would have succeeded — a real `deepseek-official` search takes more than five seconds, so a 5 s budget kills it while 20 s is fine.

One known limit: the deadline ends the attempt, it does not kill the request in flight. Providers that honour the contract — the shipped deepseek and exa both pass the signal to `fetch` — cancel with it; an adapter that ignores the signal runs its request to completion.

## When it fails

A fully failed chain throws one `WebError` with code `WEB_PROVIDER_ERROR` (`WEB_PROVIDER_UNAVAILABLE` when there was no candidate at all). The message lists every provider's outcome with the provider's own text left intact, so the real cause — a 401, a missing key — is right there:

```
every candidate web search provider behind "auto-fallback" failed:
- exa: error: WEB_PROVIDER_ERROR: Exa API error (HTTP 401)
- deepseek-official: timeout: timed out after 20000 ms
- brave: skipped (excluded)
```

Cancellation — a tool timeout, or the user stopping the turn — throws `WEB_ABORTED` immediately and does not try the next provider. That call was cancelled; this provider was not judged.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Searches still reach the old provider | The `web` row's `searchProvider` does not name `auto-fallback`. A profile layer overrides a bundle layer. |
| `WEB_PROVIDER_CONFIGURED_MISSING: auto-fallback` | This profile does not have the plugin installed, or an insert row's `name` is wrong. |
| `... has no candidate provider to try (...)` | The chain has no candidate. The message carries `order`, `exclude`, and the registry count; read it. |
| The second provider is never tried | `timeoutSeconds` is too large and the outer `tool-web.searchTimeoutMs` cuts the call first. |
| A log line about `does not expose a readable search-provider registry` | `ctx.web` changed shape. The router reads `ctx.web.searchProviders` (a `Map`); the verified version is `@deepseek-ai/dsh-web@0.1.5-alpha.1`. |

That last one is the plugin's most fragile edge: `ctx.web` exposes no enumeration API, so the router has to read that field. When it cannot, it fails closed quietly instead of throwing from deep inside a search, and `test/contract.test.js` fails loudly the moment the shape changes.

## Development

```powershell
pnpm install
npm test      # node --test, 46 cases, no network
```

`lib/order.js` holds the pure logic (ordering and the fallback walk; no DSH imports, the error constructor is injected), `lib/registry.js` is the only place that reads `ctx.web.searchProviders`, `lib/provider.js` is a thin adapter, and `lib/index.js` is the cordis plugin itself. `test/seam.test.js` and `test/contract.test.js` run against the shipped `WebRuntime` and a real cordis `Context` rather than a mocked seam.

## Scope

Search only, not `fetch`, and only providers that are already installed. If you want bundled backends, key pools, cooldowns or circuit breaking, see [dsh-web-search-router](https://github.com/Kerberos255/dsh-web-search-router), [dsh-web-search-aggregation](https://github.com/chendefine/dsh-web-search-aggregation), or [websearch-dsh](https://github.com/takasurazeem/websearch-dsh). This plugin has none of that, and no browser settings card yet.

## License

MIT
