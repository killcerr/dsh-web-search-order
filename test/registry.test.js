import test from 'node:test'
import assert from 'node:assert/strict'
import { snapshotSearchProviders } from '../lib/registry.js'

/** Build a fake `ctx.web` exposing a provider registry. */
function webWith(entries) {
  return { searchProviders: new Map(entries) }
}

const providerA = { id: 'a', available: () => true, search: async () => ({ sources: [], truncated: false }) }
const providerB = { id: 'b', available: () => true, search: async () => ({ sources: [], truncated: false }) }

test('snapshot preserves registry order', () => {
  const snapshot = snapshotSearchProviders(webWith([['b', providerB], ['a', providerA]]))
  assert.deepEqual(
    snapshot.map((entry) => entry.id),
    ['b', 'a'],
  )
  assert.equal(snapshot[0].provider, providerB)
})

test('a missing or non-Map registry fails closed', () => {
  assert.equal(snapshotSearchProviders({}), undefined)
  assert.equal(snapshotSearchProviders({ searchProviders: [] }), undefined)
  assert.equal(snapshotSearchProviders({ searchProviders: {} }), undefined)
  assert.equal(snapshotSearchProviders(null), undefined)
  assert.equal(snapshotSearchProviders(undefined), undefined)
})

test('entries without a usable id are dropped', () => {
  const web = webWith([
    ['a', providerA],
    ['bad', { available: () => true }],
    ['empty', { id: '' }],
    ['nil', null],
  ])
  const snapshot = snapshotSearchProviders(web)
  assert.deepEqual(
    snapshot.map((entry) => entry.id),
    ['a'],
  )
})
