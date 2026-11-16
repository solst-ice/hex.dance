/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import HexRow from './hex/HexRow'
import Scrollbar from './hex/Scrollbar'
import StatusBar from './hex/StatusBar'
import GoToDialog from './hex/GoToDialog'
import { EditLog } from './hex/editLog'
import { HEX, hexText, asciiText, downloadName } from './hex/bytes'
import { parseOffset } from './hex/offsets'
import {
  chooseBytesPerRow, rowCount, maxTopRow, clampRow, rowOf, ensureVisible, comfortableTop, wheelPixels, GROUP_SIZE
} from './hex/layout'
import {
  rangeBetween, normalizeSelection, sameSelection, clipToRow, anchorFor, moveCursor
} from './hex/selection'
import { buildHighlightIndex, segmentsIn } from './hex/highlights'
import { createHoverStore } from './hex/hoverStore'
import './hex/hex.css'

// Rows have a fixed height (hex.css reads it from --hx-row-h)
const ROW_PX = 20
const COPY_LIMIT = 16 * 1024 * 1024
const FLASH_MS = 1400
const NOTICE_MS = 2500
const NO_SEGMENTS = []

const NAV_KEYS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  PageUp: 'pageUp', PageDown: 'pageDown', Home: 'rowStart', End: 'rowEnd'
}

const bufferIds = new WeakMap()
let nextBufferId = 1
function bufferKey(buffer) {
  if (!bufferIds.has(buffer)) bufferIds.set(buffer, nextBufferId++)
  return bufferIds.get(buffer)
}

// Edits go straight into the caller's buffer, so views are never copies
function toBytes(buffer) {
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  return new Uint8Array(buffer)
}

function cellInfo(el, body) {
  const cell = el?.closest?.('.hx-cell[data-offset]')
  if (!cell || !body.contains(cell)) return null
  return {
    offset: Number(cell.dataset.offset),
    column: cell.parentElement.classList.contains('hx-text') ? 'text' : 'hex'
  }
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    area.remove()
    return ok
  }
}

/**
 * Hex view and editor. Only `buffer` is required; the rest is optional:
 * `fileName`, `selection` + `onSelectionChange` (controlled selection),
 * `highlights`, `onEdit`, `apiRef` (receives `{ scrollToOffset }`), and
 * `onCursorChange(offset|null)` and `onViewportChange({ start, end, bytesPerRow, visibleRows }|null)`,
 * which report the cursor and the bytes on screen (`end` exclusive, at most
 * the size) whenever they change, and null when the view goes away.
 *
 * UI modes live out here so they survive switching files; everything tied to
 * a file lives in HexView, which is remounted for each new buffer.
 */
function HexDump(props) {
  const { buffer } = props
  const [fullscreen, setFullscreen] = useState(false)
  const [editMode, setEditMode] = useState(false)

  useEffect(() => {
    if (!fullscreen) return
    const onKeyDown = e => {
      if (e.key === 'Escape' && !e.defaultPrevented) setFullscreen(false)
    }
    const root = document.documentElement
    const overflow = root.style.overflow
    root.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      root.style.overflow = overflow
    }
  }, [fullscreen])

  if (!buffer) return null
  return (
    <HexView
      key={bufferKey(buffer)}
      {...props}
      fullscreen={fullscreen}
      setFullscreen={setFullscreen}
      editMode={editMode}
      setEditMode={setEditMode}
    />
  )
}

function HexView({
  buffer, fileName, selection, onSelectionChange, highlights, onEdit, apiRef, onCursorChange, onViewportChange,
  fullscreen, setFullscreen, editMode, setEditMode
}) {
  const bytes = useMemo(() => toBytes(buffer), [buffer])
  const size = bytes.length
  const [log] = useState(() => new EditLog())
  const [hover] = useState(createHoverStore)
  const bodyId = useId()
  const statusId = useId()

  const viewRef = useRef(null)
  const bodyRef = useRef(null)
  const probeRef = useRef(null)

  const [box, setBox] = useState({ width: 0, height: 0, ch: 0 })
  const [topOffset, setTopOffset] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [anchor, setAnchor] = useState(null)
  const [ownSelection, setOwnSelection] = useState(null)
  const [column, setColumn] = useState('hex')
  const [nibble, setNibble] = useState(0)
  const [, setRev] = useState(0)
  const [goToOpen, setGoToOpen] = useState(false)
  const [flash, setFlash] = useState(null)
  const [notice, setNotice] = useState(null)

  const bytesPerRow = chooseBytesPerRow(box.width, box.ch)
  const visibleRows = Math.max(1, Math.floor(box.height / ROW_PX))
  const totalRows = rowCount(size, bytesPerRow)
  const maxTop = maxTopRow(totalRows, visibleRows)
  const top = clampRow(Math.floor(topOffset / bytesPerRow), maxTop)
  const cur = size ? Math.min(cursor, size - 1) : 0
  const controlled = selection !== undefined
  const sel = normalizeSelection(controlled ? selection : ownSelection, size)
  const highlightIndex = useMemo(() => buildHighlightIndex(highlights), [highlights])

  // Latest values for event handlers that outlive a render. Handlers also
  // write to it so several events between two renders build on each other.
  const live = useRef(null)
  live.current = {
    top, maxTop, bytesPerRow, visibleRows, size, cur, anchor, sel, column, nibble,
    editMode, fullscreen, controlled
  }
  const callbacks = useRef(null)
  callbacks.current = { onSelectionChange, onEdit, onCursorChange, onViewportChange }

  const timers = useRef({})
  const momentum = useRef({})
  useEffect(() => {
    const t = timers.current
    return () => Object.values(t).forEach(clearTimeout)
  }, [])

  const showNotice = useCallback(text => {
    setNotice(text)
    clearTimeout(timers.current.notice)
    timers.current.notice = setTimeout(() => setNotice(null), NOTICE_MS)
  }, [])

  // ---- layout -------------------------------------------------------------

  useLayoutEffect(() => {
    const view = viewRef.current
    const body = bodyRef.current
    const probe = probeRef.current
    const measure = () => {
      const width = view.clientWidth
      const height = body.clientHeight
      const ch = probe.getBoundingClientRect().width / 10
      setBox(prev => (prev.width === width && prev.height === height && prev.ch === ch
        ? prev
        : { width, height, ch }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(view)
    observer.observe(body)
    observer.observe(probe)
    return () => observer.disconnect()
  }, [])

  const scrollToRow = useCallback(row => {
    const L = live.current
    const next = clampRow(row, L.maxTop)
    L.top = next
    setTopOffset(next * L.bytesPerRow)
    return next
  }, [])

  // ---- cursor and selection ----------------------------------------------

  const commitSelection = useCallback(next => {
    const L = live.current
    if (sameSelection(next, L.sel)) return
    L.sel = next
    if (!L.controlled) setOwnSelection(next)
    callbacks.current.onSelectionChange?.(next)
  }, [])

  const setAnchorLive = useCallback(value => {
    live.current.anchor = value
    setAnchor(value)
  }, [])

  const placeCursor = useCallback((offset, { extend = false, reveal = true } = {}) => {
    const L = live.current
    if (!L.size) return
    const next = Math.min(Math.max(0, offset), L.size - 1)
    if (extend) {
      const a = anchorFor(L.sel, L.cur, L.anchor)
      setAnchorLive(a)
      commitSelection(rangeBetween(a, next))
    } else {
      setAnchorLive(null)
      commitSelection(null)
    }
    L.cur = next
    setCursor(next)
    L.nibble = 0
    setNibble(0)
    if (reveal) scrollToRow(ensureVisible(rowOf(next, L.bytesPerRow), L.top, L.visibleRows))
  }, [commitSelection, scrollToRow, setAnchorLive])

  const chooseColumn = useCallback(value => {
    live.current.column = value
    setColumn(value)
  }, [])

  const revealOffset = useCallback(offset => {
    const L = live.current
    if (!L.size) return
    const o = Math.min(Math.max(0, Math.floor(Number(offset)) || 0), L.size - 1)
    scrollToRow(comfortableTop(rowOf(o, L.bytesPerRow), L.top, L.visibleRows))
    setFlash(prev => ({ offset: o, n: (prev?.n ?? 0) + 1 }))
    clearTimeout(timers.current.flash)
    timers.current.flash = setTimeout(() => setFlash(null), FLASH_MS)
  }, [scrollToRow])

  // ---- reporting the cursor and the visible range to the host --------------

  const viewStart = top * bytesPerRow
  const viewEnd = Math.min(size, viewStart + visibleRows * bytesPerRow)
  useLayoutEffect(() => {
    callbacks.current.onCursorChange?.(cur)
  }, [cur])
  useLayoutEffect(() => {
    callbacks.current.onViewportChange?.({ start: viewStart, end: viewEnd, bytesPerRow, visibleRows })
  }, [viewStart, viewEnd, bytesPerRow, visibleRows])
  useLayoutEffect(() => () => {
    callbacks.current.onCursorChange?.(null)
    callbacks.current.onViewportChange?.(null)
  }, [])

  useLayoutEffect(() => {
    if (!apiRef) return
    const api = { scrollToOffset: revealOffset }
    apiRef.current = api
    return () => {
      if (apiRef.current === api) apiRef.current = null
    }
  }, [apiRef, revealOffset])

  // ---- hover: applied to the DOM directly, rows never re-render for it -----

  const hoverCells = useRef([])
  const pointer = useRef(null)

  const applyHover = useCallback(offset => {
    for (const el of hoverCells.current) el.classList.remove('is-hover')
    hoverCells.current = []
    if (offset != null && bodyRef.current) {
      const cells = bodyRef.current.querySelectorAll(`.hx-cell[data-offset="${offset}"]`)
      for (const el of cells) el.classList.add('is-hover')
      hoverCells.current = [...cells]
    }
    hover.set(offset)
  }, [hover])

  // Re-apply after every commit (a row may have replaced its class names) and
  // re-target after scrolling, since a different byte is now under the pointer
  useLayoutEffect(() => {
    const p = pointer.current
    if (p) {
      const hit = cellInfo(document.elementFromPoint(p.x, p.y), bodyRef.current)
      applyHover(hit ? hit.offset : null)
    } else if (hover.get() != null) {
      applyHover(hover.get())
    }
  })

  const onMouseOver = e => {
    const hit = cellInfo(e.target, bodyRef.current)
    applyHover(hit ? hit.offset : null)
  }

  const onMouseLeave = () => {
    pointer.current = null
    applyHover(null)
  }

  // ---- editing ------------------------------------------------------------

  const notifyEdit = useCallback((type, span) => {
    setRev(r => r + 1)
    callbacks.current.onEdit?.({ type, start: span.start, end: span.end })
  }, [])

  const nibbleGroup = useRef(null)

  const typeKey = key => {
    const L = live.current
    if (!L.size) return
    const offset = L.cur
    const old = bytes[offset]
    let value
    let complete = true
    let group
    if (L.column === 'hex') {
      if (!/^[0-9a-fA-F]$/.test(key)) return
      const digit = parseInt(key, 16)
      if (L.nibble === 0) {
        nibbleGroup.current = {}
        value = (digit << 4) | (old & 0x0f)
        complete = false
      } else {
        value = (old & 0xf0) | digit
      }
      group = nibbleGroup.current
    } else {
      value = key.charCodeAt(0)
      if (value > 0xff) return
    }
    if (log.write(bytes, offset, value, { group })) notifyEdit('edit', { start: offset, end: offset + 1 })
    if (!complete) {
      L.nibble = 1
      setNibble(1)
    } else if (offset < L.size - 1) {
      placeCursor(offset + 1)
    } else {
      L.nibble = 0
      setNibble(0)
    }
  }

  const history = type => {
    const span = type === 'undo' ? log.undo(bytes) : type === 'redo' ? log.redo(bytes) : log.revertAll(bytes)
    if (!span) return
    notifyEdit(type, span)
    if (type === 'revert') {
      live.current.nibble = 0
      setNibble(0)
      showNotice(`Reverted ${span.count} ${span.count === 1 ? 'byte' : 'bytes'}`)
    } else {
      placeCursor(span.start)
    }
  }

  const download = () => {
    const blob = new Blob([bytes], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = downloadName(fileName)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  // ---- copy, go to --------------------------------------------------------

  const copy = () => {
    const L = live.current
    if (!L.size) return
    const range = L.sel || { start: L.cur, end: L.cur + 1 }
    const length = range.end - range.start
    if (length > COPY_LIMIT) {
      showNotice('Selection is too large to copy (16 MiB at most)')
      return
    }
    const asText = L.column === 'text'
    const text = asText ? asciiText(bytes, range.start, range.end) : hexText(bytes, range.start, range.end)
    writeClipboard(text).then(ok => {
      showNotice(ok
        ? `Copied ${length} ${length === 1 ? 'byte' : 'bytes'} as ${asText ? 'text' : 'hex'}`
        : 'Copying was blocked by the browser')
    })
  }

  const closeGoTo = () => {
    setGoToOpen(false)
    bodyRef.current?.focus({ preventScroll: true })
  }

  const submitGoTo = text => {
    const L = live.current
    const result = parseOffset(text, { current: L.cur, size: L.size })
    if (!result.ok) return result.error
    placeCursor(result.offset, { reveal: false })
    revealOffset(result.offset)
    closeGoTo()
    return null
  }

  // ---- keyboard -----------------------------------------------------------

  const onKeyDown = e => {
    const L = live.current
    const key = e.key
    momentum.current.stop?.()

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = key.toLowerCase()
      if (k === 'g') {
        e.preventDefault()
        if (L.size) setGoToOpen(true)
      } else if (k === 'c') {
        e.preventDefault()
        copy()
      } else if (k === 'a') {
        e.preventDefault()
        if (L.size) {
          setAnchorLive(0)
          L.cur = L.size - 1
          setCursor(L.size - 1)
          commitSelection({ start: 0, end: L.size })
        }
      } else if (k === 'z') {
        e.preventDefault()
        history(e.shiftKey ? 'redo' : 'undo')
      } else if (k === 'y') {
        e.preventDefault()
        history('redo')
      } else if (key === 'Home' || key === 'End') {
        e.preventDefault()
        placeCursor(key === 'Home' ? 0 : L.size - 1, { extend: e.shiftKey })
      }
      return
    }

    if (key === 'Escape') {
      if (L.fullscreen) {
        e.preventDefault()
        setFullscreen(false)
      } else if (L.sel) {
        e.preventDefault()
        commitSelection(null)
        setAnchorLive(null)
      }
      return
    }

    let action = NAV_KEYS[key]
    if (!action && key === ' ' && !L.editMode) action = e.shiftKey ? 'pageUp' : 'pageDown'
    if (action) {
      e.preventDefault()
      if (!L.size) return
      const next = moveCursor(L.cur, action, { bytesPerRow: L.bytesPerRow, size: L.size, pageRows: L.visibleRows })
      if (action === 'pageUp' || action === 'pageDown') {
        // Scroll by the same amount so the cursor keeps its place on screen
        scrollToRow(L.top + rowOf(next, L.bytesPerRow) - rowOf(L.cur, L.bytesPerRow))
      }
      placeCursor(next, { extend: e.shiftKey && key !== ' ' })
      return
    }

    if (L.editMode && !e.altKey && key.length === 1) {
      e.preventDefault()
      typeKey(key)
    }
  }

  // ---- pointer: click, shift+click, drag-select with auto-scroll ----------

  const drag = useRef(null)

  const stopAutoScroll = () => {
    clearInterval(timers.current.autoScroll)
    timers.current.autoScroll = null
  }

  const extendDrag = () => {
    const d = drag.current
    const body = bodyRef.current
    if (!d || !body) return
    const rect = body.getBoundingClientRect()
    const L = live.current
    if (d.y < rect.top || d.y > rect.bottom) {
      if (!timers.current.autoScroll) {
        timers.current.autoScroll = setInterval(() => {
          const dd = drag.current
          if (!dd) return stopAutoScroll()
          const r = bodyRef.current.getBoundingClientRect()
          const dir = dd.y < r.top ? -1 : dd.y > r.bottom ? 1 : 0
          if (!dir) return stopAutoScroll()
          const LL = live.current
          const distance = dir < 0 ? r.top - dd.y : dd.y - r.bottom
          const step = Math.max(1, Math.round(distance / ROW_PX))
          const nextTop = scrollToRow(LL.top + dir * step)
          const row = dir < 0 ? nextTop : Math.min(nextTop + LL.visibleRows - 1, rowCount(LL.size, LL.bytesPerRow) - 1)
          const col = LL.cur % LL.bytesPerRow
          placeCursor(row * LL.bytesPerRow + col, { extend: true, reveal: false })
        }, 50)
      }
      return
    }
    stopAutoScroll()
    const x = Math.min(Math.max(d.x, rect.left + 1), rect.right - 1)
    const hit = cellInfo(document.elementFromPoint(x, d.y), body)
    if (hit && hit.offset !== L.cur) placeCursor(hit.offset, { extend: true, reveal: false })
  }

  const onPointerDown = e => {
    momentum.current.stop?.()
    if (e.pointerType === 'touch' || e.button !== 0) return
    const body = bodyRef.current
    const hit = cellInfo(e.target, body)
    if (!hit) return
    e.preventDefault()
    body.focus({ preventScroll: true })
    chooseColumn(hit.column)
    if (e.shiftKey) {
      placeCursor(hit.offset, { extend: true, reveal: false })
    } else {
      placeCursor(hit.offset, { reveal: false })
      setAnchorLive(hit.offset)
    }
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    body.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = e => {
    if (e.pointerType !== 'touch') pointer.current = { x: e.clientX, y: e.clientY }
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    d.x = e.clientX
    d.y = e.clientY
    extendDrag()
  }

  const endDrag = e => {
    if (drag.current?.id !== e.pointerId) return
    drag.current = null
    stopAutoScroll()
  }

  // ---- wheel and touch (native listeners: they must be able to cancel) ----

  const tapRef = useRef(null)
  tapRef.current = offsetHit => {
    bodyRef.current?.focus({ preventScroll: true })
    chooseColumn(offsetHit.column)
    placeCursor(offsetHit.offset, { reveal: false })
  }

  useEffect(() => {
    const body = bodyRef.current
    let wheelRemainder = 0
    let raf = 0
    let touch = null

    const stop = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }
    momentum.current.stop = stop

    const glide = velocity => {
      let v = velocity
      let last = performance.now()
      let remainder = 0
      const step = now => {
        const dt = Math.min(48, now - last)
        last = now
        remainder += v * dt
        v *= Math.pow(0.998, dt)
        const rows = Math.trunc(remainder / ROW_PX)
        if (rows) {
          remainder -= rows * ROW_PX
          const before = live.current.top
          if (scrollToRow(before + rows) === before) { raf = 0; return }
        }
        if (Math.abs(v) < 0.03) { raf = 0; return }
        raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    }

    const onWheel = e => {
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      const L = live.current
      const px = wheelPixels(e.deltaY, e.deltaMode, ROW_PX, L.visibleRows)
      if (!px) return
      stop()
      if (px < 0 ? L.top <= 0 : L.top >= L.maxTop) {
        // Nothing left to scroll here: let the page have the wheel
        wheelRemainder = 0
        if (L.fullscreen) e.preventDefault()
        return
      }
      e.preventDefault()
      wheelRemainder += px
      const rows = Math.trunc(wheelRemainder / ROW_PX)
      if (rows) {
        wheelRemainder -= rows * ROW_PX
        scrollToRow(L.top + rows)
      }
    }

    const onTouchStart = e => {
      stop()
      if (e.touches.length !== 1) { touch = null; return }
      const t = e.touches[0]
      touch = {
        x: t.clientX, y: t.clientY, lastY: t.clientY, remainder: 0, mode: null,
        target: e.target, samples: [{ y: t.clientY, t: e.timeStamp }]
      }
    }

    const onTouchMove = e => {
      if (!touch) return
      if (e.touches.length !== 1) { touch = null; return }
      const t = e.touches[0]
      const L = live.current
      if (touch.mode === null) {
        const dx = t.clientX - touch.x
        const dy = t.clientY - touch.y
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
        const vertical = Math.abs(dy) >= Math.abs(dx)
        const canMove = dy < 0 ? L.top < L.maxTop : L.top > 0
        touch.mode = vertical && canMove ? 'view' : 'page'
      }
      if (touch.mode !== 'view') return
      if (e.cancelable) e.preventDefault()
      touch.remainder += touch.lastY - t.clientY
      touch.lastY = t.clientY
      const rows = Math.trunc(touch.remainder / ROW_PX)
      if (rows) {
        touch.remainder -= rows * ROW_PX
        scrollToRow(L.top + rows)
      }
      touch.samples.push({ y: t.clientY, t: e.timeStamp })
      while (touch.samples.length > 2 && e.timeStamp - touch.samples[0].t > 100) touch.samples.shift()
    }

    const onTouchEnd = e => {
      const tt = touch
      touch = null
      if (!tt) return
      if (tt.mode === null && e.type === 'touchend') {
        const hit = cellInfo(tt.target, body)
        if (hit) tapRef.current(hit)
        return
      }
      if (tt.mode !== 'view') return
      const first = tt.samples[0]
      const last = tt.samples[tt.samples.length - 1]
      const dt = e.timeStamp - first.t
      if (dt <= 0 || e.timeStamp - last.t > 80) return
      const velocity = (first.y - last.y) / dt
      if (Math.abs(velocity) > 0.2) glide(velocity)
    }

    body.addEventListener('wheel', onWheel, { passive: false })
    body.addEventListener('touchstart', onTouchStart, { passive: true })
    body.addEventListener('touchmove', onTouchMove, { passive: false })
    body.addEventListener('touchend', onTouchEnd)
    body.addEventListener('touchcancel', onTouchEnd)
    return () => {
      stop()
      body.removeEventListener('wheel', onWheel)
      body.removeEventListener('touchstart', onTouchStart)
      body.removeEventListener('touchmove', onTouchMove)
      body.removeEventListener('touchend', onTouchEnd)
      body.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [scrollToRow])

  // Keys should work straight away in fullscreen
  useEffect(() => {
    if (fullscreen) bodyRef.current?.focus({ preventScroll: true })
  }, [fullscreen])

  // ---- render -------------------------------------------------------------

  const rows = []
  const cursorRow = rowOf(cur, bytesPerRow)
  const lastRow = Math.min(totalRows, top + visibleRows + 1)
  const flashRow = flash ? rowOf(flash.offset, bytesPerRow) : -1
  for (let r = top; r < lastRow; r++) {
    const rowStart = r * bytesPerRow
    const clip = clipToRow(sel, rowStart, bytesPerRow)
    const isCursorRow = r === cursorRow
    rows.push(
      <HexRow
        key={r}
        row={r}
        bytesPerRow={bytesPerRow}
        bytes={bytes}
        size={size}
        log={log}
        rev={log.revision(rowStart, rowStart + bytesPerRow)}
        selFrom={clip ? clip[0] : -1}
        selTo={clip ? clip[1] : -1}
        cursorCol={isCursorRow ? cur - rowStart : -1}
        column={isCursorRow ? column : 'hex'}
        nibble={isCursorRow ? nibble : 0}
        segments={highlightIndex.segments.length
          ? segmentsIn(highlightIndex, rowStart, rowStart + bytesPerRow)
          : NO_SEGMENTS}
        flash={r === flashRow ? flash.n : 0}
      />
    )
  }

  const headerCells = []
  for (let i = 0; i < bytesPerRow; i++) {
    headerCells.push(
      <span key={i} className={'hx-cell' + (i > 0 && i % GROUP_SIZE === 0 ? ' g' : '')}>
        {HEX[i].toUpperCase()}
      </span>
    )
  }

  const modifiedCount = log.modifiedCount
  const rootClass = 'hexview hex-dump-container' +
    (editMode ? ' is-editing' : '') +
    (fullscreen ? ' is-fullscreen' : '')

  return (
    <section
      className={rootClass}
      aria-label="Hex dump"
      data-bytes-per-row={bytesPerRow}
      data-top-row={top}
      data-visible-rows={visibleRows}
      data-cursor={cur}
      data-size={size}
      style={{ '--hx-bpr': bytesPerRow, '--hx-row-h': ROW_PX + 'px' }}
    >
      <header className="hx-header">
        <h2>Hex Dump</h2>
        <div className="hx-toolbar" role="toolbar" aria-label="Hex dump controls">
          {editMode && <span className="hx-edit-label">EDITING</span>}
          <button type="button" className="hx-btn hx-btn-goto" disabled={!size}
            onClick={() => setGoToOpen(true)} title="Go to offset (Ctrl+G)">GO TO</button>
          {size > 0 && (
            <button type="button" className="hx-btn hx-btn-edit" aria-pressed={editMode}
              onClick={() => { setEditMode(!editMode); setNibble(0) }}
              title={editMode ? 'Stop editing (changes stay in place)' : 'Edit bytes in place'}>
              {editMode ? 'STOP EDITING' : 'EDIT'}
            </button>
          )}
          {editMode && size > 0 && (
            <>
              <button type="button" className="hx-btn hx-btn-column"
                onClick={() => chooseColumn(column === 'hex' ? 'text' : 'hex')}
                aria-label={`Typing into the ${column === 'hex' ? 'hex' : 'text'} column; switch column`}>
                TYPE: {column === 'hex' ? 'HEX' : 'TEXT'}
              </button>
              <button type="button" className="hx-btn hx-btn-undo" disabled={!log.canUndo}
                onClick={() => history('undo')} title="Undo (Ctrl+Z)">UNDO</button>
              <button type="button" className="hx-btn hx-btn-redo" disabled={!log.canRedo}
                onClick={() => history('redo')} title="Redo (Ctrl+Shift+Z)">REDO</button>
              <button type="button" className="hx-btn hx-btn-revert" disabled={!modifiedCount}
                onClick={() => history('revert')}>REVERT ALL</button>
            </>
          )}
          {modifiedCount > 0 && (
            <span className="hx-mod-count" data-count={modifiedCount}>
              {modifiedCount} {modifiedCount === 1 ? 'byte' : 'bytes'} modified
            </span>
          )}
          {size > 0 && (
            <button type="button" className={'hx-btn hx-btn-download' + (modifiedCount ? ' is-modified' : '')}
              onClick={download} title={`Download the current bytes as ${downloadName(fileName)}`}>
              DOWNLOAD
            </button>
          )}
          <button type="button" className="hx-btn hx-btn-fullscreen" aria-pressed={fullscreen}
            onClick={() => setFullscreen(!fullscreen)}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={fullscreen ? 'Exit fullscreen (Esc)' : 'Enter fullscreen'}>
            {fullscreen ? '⊠' : '⛶'}
          </button>
        </div>
      </header>

      {goToOpen && <GoToDialog onSubmit={submitGoTo} onClose={closeGoTo} />}

      <div className="hx-colhead" aria-hidden="true">
        <span className="hx-off">OFFSET</span>
        <span className="hx-hex">{headerCells}</span>
        <span className="hx-text">TEXT</span>
      </div>

      <div className="hx-view" ref={viewRef}>
        <div
          ref={bodyRef}
          id={bodyId}
          className="hx-body"
          tabIndex={0}
          role="application"
          aria-roledescription="hex editor"
          aria-label={`Hex view of ${fileName || 'file'}`}
          aria-describedby={statusId}
          onKeyDown={onKeyDown}
          onMouseOver={onMouseOver}
          onMouseLeave={onMouseLeave}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        >
          {size === 0
            ? <p className="hx-empty">This file is empty (0 bytes), so there is nothing to show.</p>
            : rows}
        </div>
        <Scrollbar
          controls={bodyId}
          top={top}
          maxTop={maxTop}
          visibleRows={visibleRows}
          totalRows={totalRows}
          onScroll={scrollToRow}
          onJumpStart={() => scrollToRow(0)}
          onJumpEnd={() => scrollToRow(live.current.maxTop)}
        />
      </div>

      <StatusBar
        id={statusId}
        hover={hover}
        bytes={bytes}
        size={size}
        cursor={cur}
        selection={sel}
        highlightIndex={highlightIndex}
        modifiedCount={modifiedCount}
        notice={notice}
      />
      <span className="hx-probe" ref={probeRef} aria-hidden="true">0000000000</span>
    </section>
  )
}

export default HexDump
