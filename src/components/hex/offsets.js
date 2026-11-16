// Parses what people type into "go to offset":
//   0x1f40, 1F40h, 8000 (decimal), 1f40 (bare hex when it has a letter),
//   +n / -n relative to the current offset, n in any of the forms above.
export function parseOffset(input, { current = 0, size }) {
  const text = String(input ?? '').trim().toLowerCase().replace(/[\s_]/g, '')
  if (!text) return { ok: false, error: 'Enter an offset' }

  let sign = 0
  let body = text
  if (body[0] === '+' || body[0] === '-') {
    sign = body[0] === '+' ? 1 : -1
    body = body.slice(1)
  }

  let value
  if (/^0x[0-9a-f]+$/.test(body)) value = parseInt(body.slice(2), 16)
  else if (/^[0-9a-f]+h$/.test(body)) value = parseInt(body.slice(0, -1), 16)
  else if (/^\d+$/.test(body)) value = parseInt(body, 10)
  else if (/^[0-9a-f]+$/.test(body)) value = parseInt(body, 16)
  else return { ok: false, error: 'Not an offset: use 0x1F40, 1F40h, 8000 or +/-n' }

  if (!Number.isSafeInteger(value)) return { ok: false, error: 'Offset is too large' }

  const offset = sign === 0 ? value : current + sign * value
  if (size <= 0) return { ok: false, error: 'The file is empty' }
  if (offset < 0) return { ok: false, error: 'Offset is before the start of the file' }
  if (offset >= size) {
    return { ok: false, error: `Offset is past the end (last byte is 0x${(size - 1).toString(16)})` }
  }
  return { ok: true, offset }
}
