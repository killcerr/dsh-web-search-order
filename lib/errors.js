/**
 * The router's error vocabulary, built on the seam's own `WebError` so codes
 * and the `cause` chain stay identical to every other web provider.
 *
 * @module dsh-web-search-order/errors
 */
import { WebError } from '@deepseek-ai/dsh-web'

/**
 * Construct a seam `WebError`.
 *
 * @param message - model-facing message; the router keeps it single-block and
 *   free of credential material.
 * @param code - machine-routable code from the seam's shared vocabulary
 *   (`WEB_ABORTED`, `WEB_PROVIDER_ERROR`, `WEB_PROVIDER_UNAVAILABLE`).
 * @param options - optional `{ cause }` chain.
 * @returns the typed error to throw.
 */
export function createWebError(message, code, options) {
  return options === undefined ? new WebError(message, code) : new WebError(message, code, options)
}
