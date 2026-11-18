/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { currentCrt, subscribeCrt } from './themes'
import useReducedMotion from './useReducedMotion'
import {
  INPUT_QUIET_MS, filterAttributes, nextBlipDelay, nextBurstDelay, planBlip, planBurst, seededRandom
} from '../lib/crtGlitch.js'

// The filter's attributes before the first burst, so that setting
// data-crt-burst on <html> by hand shows a real burst
const FIRST_STEP = planBurst(seededRandom(7)).steps[0]
const FIRST = filterAttributes({ ...FIRST_STEP, scale: 120, split: 8 })

// How long the picture takes to open when the mode is switched on; the
// first burst lands just after it opens. Keep in sync with crt-shutter in crt.css.
const POWER_ON_MS = 650

/**
 * The burst filter. While <html> carries data-crt-burst, crt.css applies it
 * to the root element: noise that varies only down the screen is cut into
 * bands of rows, which shift sideways by different amounts (and, in big
 * bursts, slip vertically); then the red channel and the rest are pulled
 * apart and the whole picture jumps. It is on the root because a filter on
 * any other element would make fixed-position descendants position against
 * that element; the root is exempt.
 */
function BurstFilter({ svgRef }) {
  return (
    <svg ref={svgRef} className="crt-defs" width="0" height="0" focusable="false">
      <filter id="hd-crt-burst" x="-5%" y="0%" width="110%" height="100%" colorInterpolationFilters="sRGB">
        <feTurbulence data-role="noise" type="fractalNoise" numOctaves="1" {...FIRST.noise} result="noise" />
        <feComponentTransfer in="noise" result="bands">
          <feFuncR data-role="tearX" type="discrete" {...FIRST.tearX} />
          <feFuncG data-role="tearY" type="discrete" {...FIRST.tearY} />
        </feComponentTransfer>
        <feDisplacementMap
          data-role="tear"
          in="SourceGraphic"
          in2="bands"
          xChannelSelector="R"
          yChannelSelector="G"
          {...FIRST.tear}
          result="torn"
        />
        <feColorMatrix in="torn" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="redOnly" />
        <feOffset data-role="red" in="redOnly" dy="0" {...FIRST.red} result="red" />
        <feColorMatrix in="torn" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" result="restOnly" />
        <feOffset data-role="rest" in="restOnly" dy="0" {...FIRST.rest} result="rest" />
        <feComposite in="red" in2="rest" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="split" />
        <feOffset data-role="jump" in="split" dx="0" {...FIRST.jump} />
      </filter>
    </svg>
  )
}

// Input that means someone is scrolling, selecting or typing
const INPUT_EVENTS = ['wheel', 'scroll', 'pointerdown', 'pointermove', 'keydown']

// Runs the bursts and blips while the tube is on and the tab is visible.
// Bursts hold off while someone is scrolling, selecting or typing, and an
// input cuts a running burst short: the picture is never filtered while it
// has to follow the hand, and on a machine that draws the filter slowly the
// cost lands only on a still screen.
function useGlitches(screenRef, svgRef, firstDelay) {
  useEffect(() => {
    const root = document.documentElement
    const screen = screenRef.current
    const svg = svgRef.current
    if (!screen || !svg) return
    const parts = {}
    svg.querySelectorAll('[data-role]').forEach(element => {
      parts[element.dataset.role] = element
    })
    const lines = [...screen.querySelectorAll('.crt-blip')]
    const random = Math.random

    const timers = new Set()
    const later = (fn, ms) => {
      const id = setTimeout(() => {
        timers.delete(id)
        fn()
      }, ms)
      timers.add(id)
      return id
    }

    const applyStep = step => {
      for (const [role, attributes] of Object.entries(filterAttributes(step, window.innerWidth))) {
        for (const [name, value] of Object.entries(attributes)) parts[role]?.setAttribute(name, value)
      }
    }

    let burstTimers = []
    let lastInput = -Infinity
    const endBurst = () => {
      burstTimers.forEach(id => {
        clearTimeout(id)
        timers.delete(id)
      })
      burstTimers = []
      delete root.dataset.crtBurst
    }

    const hideBlip = () => {
      lines.forEach(line => {
        line.style.opacity = '0'
      })
    }

    const scheduleBurst = delay => later(burst, delay)
    const burst = () => {
      const quiet = performance.now() - lastInput
      if (quiet < INPUT_QUIET_MS) return scheduleBurst(INPUT_QUIET_MS - quiet + 100)
      const plan = planBurst(random)
      // The band of static and its drift are on the overlay, not on <html>:
      // custom properties on the root would restyle the whole page
      const band = plan.band
      screen.style.setProperty('--crt-band-opacity', band ? band.opacity : 0)
      if (band) {
        screen.style.setProperty('--crt-band-top', band.top)
        screen.style.setProperty('--crt-band-height', band.height)
        screen.style.setProperty('--crt-band-drift', band.drift)
      }
      screen.style.setProperty('--crt-burst-ms', `${plan.duration}ms`)
      let at = 0
      burstTimers = plan.steps.map((step, index) => {
        const id = later(() => {
          applyStep(step)
          if (index === 0) root.dataset.crtBurst = plan.kind
        }, at)
        at += step.ms
        return id
      })
      burstTimers.push(later(() => {
        endBurst()
        scheduleBurst(nextBurstDelay(random))
      }, plan.duration))
    }

    const handleInput = event => {
      if (event.type === 'pointermove' && !event.buttons) return
      lastInput = performance.now()
      if (burstTimers.length) {
        endBurst()
        scheduleBurst(nextBurstDelay(random))
      }
    }

    const scheduleBlip = delay => later(blip, delay)
    const blip = () => {
      const plan = planBlip(random)
      lines.forEach((line, index) => {
        const spec = plan.lines[index]
        if (!spec) return
        line.dataset.tone = spec.bright ? 'bright' : 'dark'
        line.style.transform = `translateY(${(spec.top * 100).toFixed(2)}vh) scaleY(${spec.height})`
        line.style.opacity = String(spec.opacity)
      })
      later(() => {
        hideBlip()
        scheduleBlip(nextBlipDelay(random))
      }, plan.duration)
    }

    const stop = () => {
      timers.forEach(clearTimeout)
      timers.clear()
      endBurst()
      hideBlip()
    }
    const start = delay => {
      scheduleBurst(delay)
      scheduleBlip(nextBlipDelay(random))
    }

    // Nothing runs in a hidden tab; coming back starts a fresh wait
    const handleVisibility = () => {
      stop()
      if (!document.hidden) start(nextBurstDelay(random))
    }

    if (!document.hidden) start(firstDelay ?? nextBurstDelay(random))
    document.addEventListener('visibilitychange', handleVisibility)
    const options = { capture: true, passive: true }
    INPUT_EVENTS.forEach(type => window.addEventListener(type, handleInput, options))
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      INPUT_EVENTS.forEach(type => window.removeEventListener(type, handleInput, options))
      stop()
    }
  }, [screenRef, svgRef, firstDelay])
}

// The tube itself, mounted only while the mode is on
function Tube({ powerOn }) {
  const screenRef = useRef(null)
  const svgRef = useRef(null)
  const [powering, setPowering] = useState(powerOn)
  useGlitches(screenRef, svgRef, powerOn ? POWER_ON_MS + 60 : null)

  return (
    <div ref={screenRef} className="crt" aria-hidden="true">
      <div className="crt-scanlines" />
      <div className="crt-hum" />
      <div className="crt-grain" />
      <div className="crt-band" />
      <div className="crt-blips">
        <i className="crt-blip" />
        <i className="crt-blip" />
        <i className="crt-blip" />
      </div>
      <div className="crt-flicker" />
      {powering && (
        <div className="crt-power">
          <i className="crt-shutter crt-shutter--top" />
          <i className="crt-shutter crt-shutter--bottom" onAnimationEnd={() => setPowering(false)} />
          <i className="crt-power-line" />
        </div>
      )}
      <BurstFilter svgRef={svgRef} />
    </div>
  )
}

/**
 * CRT mode: a failing cathode-ray monitor drawn over the page. The steady
 * part is overlays that only move or fade (crt.css); the glitch bursts filter
 * the root element for a few hundred milliseconds at a time. Switching the
 * mode on opens the picture from a bright line; switching it off cuts.
 * Nothing is mounted, and no timer runs, while the mode is off or reduced
 * motion is requested.
 */
function CrtScreen() {
  const on = useSyncExternalStore(subscribeCrt, currentCrt, () => false)
  const reducedMotion = useReducedMotion()
  // On at page load (applied before the first paint) is not a switch-on
  const [onAtLoad] = useState(on)
  const [switched, setSwitched] = useState(false)

  useEffect(() => {
    if (!on) setSwitched(true)
  }, [on])

  if (!on || reducedMotion) return null
  return <Tube powerOn={switched || !onAtLoad} />
}

export default CrtScreen
