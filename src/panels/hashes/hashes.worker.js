import { ALGORITHMS } from './digests.js'
import { acceptChunks } from '../../lib/chunkStream.js'

let hashers = []

acceptChunks({
  begin({ algorithms }) {
    hashers = ALGORITHMS.filter(({ id }) => algorithms.includes(id)).map(({ id, create }) => ({ id, hasher: create() }))
  },
  chunk(bytes, offset, from, last) {
    for (const { hasher } of hashers) hasher.update(bytes, from - offset)
    self.postMessage({ type: 'progress', position: offset + bytes.length })
    if (last) {
      const hashes = {}
      for (const { id, hasher } of hashers) hashes[id] = hasher.digest()
      self.postMessage({ type: 'done', hashes })
    }
  }
})
