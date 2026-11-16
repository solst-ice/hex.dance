import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  },
  base: '/',
  // The analysis worker is created with { type: 'module' }
  worker: {
    format: 'es'
  },
})
