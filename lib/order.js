/**
 * Pure candidate ordering and fallback-walk logic for the `auto-fallback` web
 * search router.
 *
 * This module deliberately imports nothing from the harness: the error
 * constructor is injected by the caller, so the same walk can be unit-tested
 * without `@deepseek-ai/dsh-web` and the router keeps one error vocabulary.
 *
 * @module dsh-web-search-order/order
 */

/**
 * Default per-attempt budget in seconds.
 *
 * This is router policy, not an upstream limit: the seam
 * (`@deepseek-ai/dsh-web`) has no per-provider timeout at all — a provider is
 * only ever handed an `AbortSignal`. The budget exists so a slow first provider
 * cannot consume the whole tool-call budget declared by
 * `dsh-tool-web.searchTimeoutMs` (30000 by default, 60000 in this deployment)
 * and starve the chain; 20 s keeps roughly three attempts inside that budget.
 */
export const DEFAULT_TIMEOUT_SECONDS = 20

/**
 * Largest delay `setTimeout` honors.
 *
 * Node coerces any larger delay to 1 ms and emits a `TimeoutOverflowWarning`,
 * so an absurdly large configured budget would silently become an instant
 * timeout — the opposite of what the user asked for. Clamping here makes
 * "absurdly large" mean "effectively no deadline" instead.
 */
export const MAX_TIMER_MS = 2_147_483_647

/** Outcome marker for an attempt whose budget expired before it settled. */
const ATTEMPT_EXPIRED = Symbol('attempt-expired')

/**
 * Convert a configured per-attempt budget into milliseconds.
 *
 * A missing, non-finite, or non-positive value falls back to
 * {@link DEFAULT_TIMEOUT_SECONDS} rather than yielding `NaN`, which `setTimeout`
 * treats as `0` and which would turn every attempt into an instant timeout.
 * Values above {@link MAX_TIMER_MS} saturate at that limit.
 *
 * @param value - the configured `timeoutSeconds` value.
 * @returns the per-attempt budget in milliseconds.
 */
export function timeoutSecondsToMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_SECONDS * 1000
  }
  return Math.min(Math.round(value * 1000), MAX_TIMER_MS)
}

/**
 * Decide whether a provider result is worth returning.
 *
 * Mirrors what `dsh-tool-web` can render: at least one source, or a non-blank
 * provider-generated answer. A provider that returned neither is treated as a
 * miss so the chain can continue.
 *
 * @param result - the provider's normalized search result (possibly malformed).
 * @returns true when the result carries renderable content.
 */
export function isUsableResult(result) {
  if (result === null || typeof result !== 'object') return false
  if (Array.isArray(result.sources) && result.sources.length > 0) return true
  return typeof result.content === 'string' && result.content.trim().length > 0
}

/**
 * Order the registered search providers into the chain the router will walk.
 *
 * Ordering follows the omp `providers.webSearchOrder` contract:
 * 1. ids named by `order` come first, in that order, first occurrence only;
 * 2. providers omitted from `order` follow in their live registry order;
 * 3. an empty `order` preserves the registry order;
 * 4. `exclude` removes a provider entirely — including one named by `order`;
 * 5. the router's own id is never a candidate.
 *
 * @param providers - `{ id, provider }` entries in live registry order.
 * @param options - the `order`, `exclude`, and `selfId` to apply.
 * @returns the ordered candidates plus the entries that were skipped and any
 *   `order` ids that name no registered provider.
 */
export function resolveCandidates(providers, options = {}) {
  const order = Array.isArray(options.order) ? options.order : []
  const exclude = new Set(Array.isArray(options.exclude) ? options.exclude : [])
  const selfId = options.selfId

  /** Registry order, deduplicated by id. */
  const registered = []
  const byId = new Map()
  for (const entry of Array.isArray(providers) ? providers : []) {
    if (entry === null || typeof entry !== 'object') continue
    const { id } = entry
    if (typeof id !== 'string' || id.length === 0 || byId.has(id)) continue
    byId.set(id, entry)
    registered.push(entry)
  }

  const candidates = []
  const skipped = []
  const unknownOrderIds = []
  const seen = new Set()

  /** Record a provider that will not be tried, once. */
  const skip = (id, reason) => {
    seen.add(id)
    skipped.push({ id, reason })
  }

  for (const id of order) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    if (id === selfId) {
      skip(id, 'router-id')
    } else if (exclude.has(id)) {
      skip(id, 'excluded')
    } else {
      const entry = byId.get(id)
      if (entry === undefined) {
        seen.add(id)
        unknownOrderIds.push(id)
      } else {
        seen.add(id)
        candidates.push(entry)
      }
    }
  }

  for (const entry of registered) {
    const { id } = entry
    if (seen.has(id)) continue
    if (id === selfId) {
      skip(id, 'router-id')
    } else if (exclude.has(id)) {
      skip(id, 'excluded')
    } else {
      seen.add(id)
      candidates.push(entry)
    }
  }

  return { candidates, skipped, unknownOrderIds }
}

/**
 * Walk the candidate chain until one provider yields a usable result.
 *
 * Per attempt the provider is given a signal that aborts on either the caller's
 * cancellation or the per-attempt budget, and both are enforced here rather
 * than delegated: the attempt races the deadline and the caller's cancellation,
 * so a provider that ignores `signal` still loses its turn, and a result that
 * lands after either bound is not treated as this attempt's outcome. A caller
 * abort stops the walk and rethrows `WEB_ABORTED`; an expired deadline or a
 * provider failure is recorded and the next candidate runs. When no candidate
 * produced a usable result, one `WebError` carries a per-provider summary.
 *
 * @param options - the candidates, request, cancellation, budgets, and helpers.
 *   `timeoutMs` is a normalized budget in milliseconds (see
 *   {@link timeoutSecondsToMs}).
 * @returns the first usable provider result, passed through unchanged so the
 *   seam still enforces `maxResults`.
 * @throws {Error} the injected error type: `WEB_ABORTED` on caller cancellation,
 *   `WEB_PROVIDER_UNAVAILABLE` when nothing was attempted, or
 *   `WEB_PROVIDER_ERROR` when every attempt failed.
 */
export async function runSearchChain(options) {
  const {
    candidates = [],
    skipped = [],
    unknownOrderIds = [],
    request,
    signal,
    timeoutMs,
    fallbackOnEmpty = true,
    createError,
    logger,
    providerId = 'auto-fallback',
    order = [],
    exclude = [],
    registryCount = 0,
  } = options

  const callerAborted = () => signal !== undefined && signal.aborted

  const aborted = () =>
    createError('web search aborted', 'WEB_ABORTED', {
      cause: signal === undefined ? undefined : signal.reason,
    })

  if (callerAborted()) throw aborted()

  const attempts = []
  let firstError

  for (const candidate of candidates) {
    if (callerAborted()) throw aborted()

    const { id, provider } = candidate

    let available = false
    try {
      available = provider.available() === true
    } catch (error) {
      attempts.push({ id, outcome: 'unavailable', detail: describeReason(error) })
      logger?.warn?.(`${providerId}: ${id} availability check failed; skipping`)
      continue
    }
    if (!available) {
      attempts.push({ id, outcome: 'unavailable', detail: 'not configured' })
      continue
    }

    const controller = new AbortController()
    const attemptSignal =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])

    // The budget is enforced here, not delegated to the provider. `signal` is
    // the seam's only cancellation channel and a provider is contractually
    // required to honor it, but a router that merely passed it along would
    // never advance past a provider that ignores it. Racing the deadline makes
    // the budget a guarantee of this module; the abandoned operation keeps
    // running, so its eventual rejection is observed and dropped rather than
    // surfacing as an unhandled rejection.
    let timer
    let detachCancellation = () => {}
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`provider ${id} exceeded ${timeoutMs} ms`))
        resolve(ATTEMPT_EXPIRED)
      }, timeoutMs)
    })
    // A caller abort must be honored promptly even when the budget is long or
    // the provider ignores `signal`, so it races as its own outcome.
    const cancelled =
      signal === undefined
        ? undefined
        : new Promise((_, reject) => {
            const onAbort = () => reject(aborted())
            detachCancellation = () => signal.removeEventListener('abort', onAbort)
            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener('abort', onAbort, { once: true })
          })

    // Wrapped so a provider that throws synchronously still produces one
    // failure path (a rejected promise) for the race below.
    const pending = (async () => provider.search(request, attemptSignal))()
    pending.catch(() => {})

    let result
    try {
      result = await Promise.race(
        cancelled === undefined ? [pending, expired] : [pending, expired, cancelled],
      )
    } catch (error) {
      if (callerAborted()) throw aborted()
      // The deadline settles `expired` synchronously inside the timer callback,
      // so a rejection it provoked lands after the race has already been decided
      // — this branch is defensive. Reaching it means the provider rejected
      // while the deadline stood, and the deadline owns that label: whatever
      // text an abort-provoked rejection carries describes the abort, not a
      // diagnosis worth keeping.
      if (controller.signal.aborted) {
        attempts.push({ id, outcome: 'timeout', detail: `timed out after ${timeoutMs} ms` })
        logger?.warn?.(`${providerId}: ${id} timed out after ${timeoutMs} ms; trying the next provider`)
      } else {
        attempts.push({ id, outcome: 'error', detail: describeReason(error) })
        if (firstError === undefined) firstError = error
        logger?.warn?.(`${providerId}: ${id} failed (${describeReason(error)}); trying the next provider`)
      }
      continue
    } finally {
      clearTimeout(timer)
      detachCancellation()
    }

    if (callerAborted()) throw aborted()
    // The provider resolved after its budget expired: the late result is not
    // this attempt's outcome, so the deadline still wins.
    if (result === ATTEMPT_EXPIRED || controller.signal.aborted) {
      attempts.push({ id, outcome: 'timeout', detail: `timed out after ${timeoutMs} ms` })
      logger?.warn?.(`${providerId}: ${id} timed out after ${timeoutMs} ms; trying the next provider`)
      continue
    }

    if (fallbackOnEmpty && !isUsableResult(result)) {
      attempts.push({ id, outcome: 'empty', detail: 'returned no usable result' })
      logger?.warn?.(`${providerId}: ${id} returned no usable result; trying the next provider`)
      continue
    }

    return result
  }

  const attempted = attempts.some((attempt) => attempt.outcome !== 'unavailable')
  const code = attempted ? 'WEB_PROVIDER_ERROR' : 'WEB_PROVIDER_UNAVAILABLE'
  const message = buildFailureMessage({
    providerId,
    candidates,
    attempts,
    skipped,
    unknownOrderIds,
    order,
    exclude,
    registryCount,
  })
  logger?.warn?.(`${providerId}: ${message}`)
  throw createError(message, code, firstError === undefined ? undefined : { cause: firstError })
}

/** Render one aggregate failure message. Every candidate is listed. */
function buildFailureMessage(context) {
  const { providerId, candidates, attempts, skipped, unknownOrderIds, order, exclude, registryCount } = context
  const lines = []
  for (const attempt of attempts) lines.push(`${attempt.id}: ${formatAttempt(attempt)}`)
  for (const id of unknownOrderIds) lines.push(`${id}: not registered (ignored from order)`)
  for (const entry of skipped) lines.push(`${entry.id}: skipped (${entry.reason})`)

  const head =
    candidates.length === 0
      ? `web search router "${providerId}" has no candidate provider to try ` +
        `(registry: ${registryCount} provider(s); order: ${formatList(order)}; exclude: ${formatList(exclude)})`
      : `every candidate web search provider behind "${providerId}" failed`

  if (lines.length === 0) return head
  return `${head}:\n${lines.join('\n')}`
}

/** Render one attempt's outcome as `outcome: detail`. */
function formatAttempt(attempt) {
  const detail = attempt.detail === undefined ? '' : `: ${attempt.detail}`
  return `${attempt.outcome}${detail}`
}

/**
 * Render a provider error as one line, keeping its machine code verbatim.
 *
 * The provider's own message is never truncated: shipped providers put
 * actionable guidance in it (DeepSeek's endpoint failure names the settings
 * page that fixes it), and cutting that off would be worse than a longer line.
 */
function describeReason(error) {
  const code =
    error !== null &&
    typeof error === 'object' &&
    typeof error.code === 'string' &&
    error.code.length > 0
      ? error.code
      : undefined
  const text = oneLine(error instanceof Error ? error.message : String(error))
  return code === undefined ? text : `${code}: ${text}`
}

/** Collapse whitespace so one provider reason stays on one line. */
function oneLine(value) {
  return String(value).replace(/\s+/gu, ' ').trim()
}

/** Render a configuration list for the no-candidate diagnostic. */
function formatList(value) {
  return Array.isArray(value) && value.length > 0 ? `[${value.join(', ')}]` : '[]'
}
