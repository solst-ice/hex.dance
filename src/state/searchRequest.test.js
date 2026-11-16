import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestSearch, subscribeSearchRequests, takeSearchRequest } from './searchRequest.js'

test('hands one pending search request to whoever takes it', () => {
  let heard = 0
  const stop = subscribeSearchRequests(() => heard++)
  requestSearch({ mode: 'hex', query: '7f 45' })
  requestSearch({ mode: 'hex', query: '4c 46' })
  assert.equal(heard, 2)
  const request = takeSearchRequest()
  assert.equal(request.query, '4c 46')
  assert.ok(request.seq > 0)
  assert.equal(takeSearchRequest(), null)
  stop()
  requestSearch({})
  assert.equal(heard, 2)
  takeSearchRequest()
})
