import { createHash } from 'node:crypto'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The page's Content-Security-Policy allows scripts from 'self' only. The dev
// server inlines a script of its own (React refresh's preamble), so in dev
// only, the policy also allows each inline script the served page actually
// has, by its hash. It runs last, after every other plugin has added its
// tags, so a new version of the snippet never breaks `npm run dev`, and the
// built page keeps the plain policy from index.html.
function allowDevInlineScripts() {
  return {
    name: 'hexdance:allow-dev-inline-scripts',
    apply: 'serve',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const hashes = []
        for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
          if (/\bsrc\s*=/i.test(attributes) || !body) continue
          hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
        }
        if (hashes.length === 0) return html
        let found = false
        const result = html.replace(
          /(<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*?script-src 'self')/i,
          (match) => {
            found = true
            return `${match} ${[...new Set(hashes)].join(' ')}`
          }
        )
        // Better a loud failure than a page whose scripts are silently blocked
        if (!found) throw new Error('The Content-Security-Policy in index.html has no "script-src \'self\'" to extend')
        return result
      }
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), allowDevInlineScripts()],
  server: {
    port: 5173
  },
  base: '/',
  // The analysis worker is created with { type: 'module' }
  worker: {
    format: 'es'
  },
})
