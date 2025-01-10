import { useEffect } from 'react'

function GlitchFavicon() {
  useEffect(() => {
    const faviconVariations = [
      `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <rect width="32" height="32" fill="#060714"/>
        <text x="4" y="22" style="font: bold 20px 'Courier New'; fill: #0ff; filter: drop-shadow(0 0 2px #0ff)">0x</text>
      </svg>`,
      
      `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <rect width="32" height="32" fill="#060714"/>
        <text x="6" y="21" style="font: bold 20px 'Courier New'; fill: #ff36ab; filter: drop-shadow(0 0 3px #ff36ab)">0x</text>
      </svg>`,
      
      `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <rect width="32" height="32" fill="#060714"/>
        <text x="2" y="23" style="font: bold 20px 'Courier New'; fill: #0ff; filter: drop-shadow(0 0 2px #0ff)">0x</text>
      </svg>`,
      
      `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <rect width="32" height="32" fill="#060714"/>
        <text x="4" y="22" style="font: bold 20px 'Courier New'; fill: #ff36ab; transform: skewX(10deg); filter: drop-shadow(0 0 2px #ff36ab)">0x</text>
      </svg>`
    ]

    let currentIndex = 0
    const favicon = document.querySelector('link[rel="icon"]')
    
    function updateFavicon() {
      // Normal state
      favicon.href = `data:image/svg+xml;base64,${btoa(faviconVariations[0])}`
      
      // Random glitch timing
      const glitchInterval = setInterval(() => {
        // Rapid glitch effect
        for (let i = 0; i < 3; i++) {
          setTimeout(() => {
            currentIndex = (currentIndex + 1) % faviconVariations.length
            favicon.href = `data:image/svg+xml;base64,${btoa(faviconVariations[currentIndex])}`
          }, i * 100)
        }
        
        // Reset to normal after glitch
        setTimeout(() => {
          favicon.href = `data:image/svg+xml;base64,${btoa(faviconVariations[0])}`
        }, 400)
      }, 2000 + Math.random() * 3000) // Random interval between 2-5 seconds

      return () => clearInterval(glitchInterval)
    }

    return updateFavicon()
  }, [])

  return null
}

export default GlitchFavicon 