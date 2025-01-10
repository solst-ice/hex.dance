import React, { useEffect, useRef } from 'react'

function MatrixRain({ brightness = 0.3, color = '#0ff' }) {
  const canvasRef = useRef(null)
  const brightnessRef = useRef(brightness)
  const colorRef = useRef(color)
  const animationRef = useRef(null)
  const dropsRef = useRef([])
  const charStatesRef = useRef([])
  const columnsRef = useRef(0)

  // Animation settings - move outside effect to be accessible
  const fontSize = 14
  const columnSpacing = fontSize * 1.2
  const maxSpeed = 0.35
  const minSpeed = 0.15
  const speedMultiplier = 0.5
  const charChangeProb = 0.15
  const trailLength = 8
  const columnActivationProb = 0.3
  const chars = 'ｦｱｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝabcdefghijklmnopqrstuvwxyz0123456789+=｢｣･ｯｭｬ'.split('')

  const initializeDrops = (canvas) => {
    if (canvas.width <= 0) return

    columnsRef.current = Math.floor(canvas.width / columnSpacing)
    if (columnsRef.current <= 0) return

    dropsRef.current = new Array(columnsRef.current).fill(0).map(() => 
      Math.random() < columnActivationProb ? 
        Math.floor(Math.random() * -canvas.height / fontSize) : 
        Infinity
    )

    charStatesRef.current = new Array(columnsRef.current).fill(0).map(() => ({
      char: chars[Math.floor(Math.random() * chars.length)],
      speed: (minSpeed + Math.random() * (maxSpeed - minSpeed)) * speedMultiplier,
      brightness: Math.random(),
      isActive: Math.random() < columnActivationProb
    }))
  }

  const draw = (ctx, canvas) => {
    if (!ctx || !canvas || columnsRef.current <= 0) return false

    ctx.fillStyle = 'rgba(6, 7, 20, 0.25)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.font = `bold ${fontSize}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    let hasActiveColumns = false

    for (let i = 0; i < dropsRef.current.length; i++) {
      if (!charStatesRef.current[i].isActive) {
        // Randomly activate inactive columns
        if (Math.random() < 0.01) {
          charStatesRef.current[i].isActive = true
          dropsRef.current[i] = -5
          hasActiveColumns = true
        }
        continue
      }

      hasActiveColumns = true
      const x = i * columnSpacing
      const y = dropsRef.current[i] * fontSize

      // More frequent character changes
      if (Math.random() < charChangeProb) {
        charStatesRef.current[i].char = chars[Math.floor(Math.random() * chars.length)]
      }

      // Leading character
      const leadOpacity = Math.min(1, brightnessRef.current * 2.0)
      ctx.fillStyle = colorRef.current.replace(')', `, ${leadOpacity})`)
      ctx.fillText(charStatesRef.current[i].char, x, y)

      // Trail with more variance
      for (let j = 1; j < trailLength; j++) {
        const trailY = y - (j * fontSize)
        if (trailY < 0) break

        const trailOpacity = Math.max(0, brightnessRef.current * Math.pow(0.7, j))
        ctx.fillStyle = colorRef.current.replace(')', `, ${trailOpacity})`)
        
        // Higher chance of different characters in trail
        const trailChar = (Math.random() < 0.4) 
          ? chars[Math.floor(Math.random() * chars.length)]
          : charStatesRef.current[i].char
          
        ctx.fillText(trailChar, x, trailY)
      }

      dropsRef.current[i] += charStatesRef.current[i].speed

      if (y > canvas.height + fontSize * trailLength) {
        if (Math.random() < 0.3) {
          charStatesRef.current[i].isActive = false
          dropsRef.current[i] = Infinity
        } else {
          dropsRef.current[i] = -5
          charStatesRef.current[i].speed = (minSpeed + Math.random() * (maxSpeed - minSpeed)) * speedMultiplier
          charStatesRef.current[i].brightness = Math.random()
        }
      }
    }

    return hasActiveColumns
  }

  const startAnimation = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const animate = () => {
      const hasActiveColumns = draw(ctx, canvas)
      if (hasActiveColumns) {
        animationRef.current = requestAnimationFrame(animate)
      }
    }

    animate()
  }

  // Handle hover
  useEffect(() => {
    const handleMouseEnter = () => {
      if (!animationRef.current) {
        // Reinitialize some columns if none are active
        const canvas = canvasRef.current
        if (canvas) {
          charStatesRef.current.forEach((state, i) => {
            if (Math.random() < columnActivationProb) {
              state.isActive = true
              dropsRef.current[i] = -5
            }
          })
          startAnimation()
        }
      }
    }

    const canvas = canvasRef.current
    if (canvas) {
      canvas.addEventListener('mouseenter', handleMouseEnter)
      return () => canvas.removeEventListener('mouseenter', handleMouseEnter)
    }
  }, [])

  // Initial setup
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resizeCanvas = () => {
      canvas.width = canvas.parentElement.offsetWidth
      canvas.height = canvas.parentElement.offsetHeight
      initializeDrops(canvas)
    }

    resizeCanvas()
    startAnimation()

    window.addEventListener('resize', resizeCanvas)
    return () => {
      window.removeEventListener('resize', resizeCanvas)
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [])

  // Update refs when props change
  useEffect(() => {
    brightnessRef.current = brightness
    colorRef.current = color
  }, [brightness, color])

  return <canvas ref={canvasRef} className="matrix-rain" />
}

export default MatrixRain 