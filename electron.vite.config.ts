import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const sharedAlias = { '@shared': resolve('src/shared') }

/**
 * A CSP de src/renderer/index.html é a de PRODUÇÃO (sem ws:/localhost). Só no servidor de desenvolvimento
 * (npm run dev) libera a conexão do HMR do Vite.
 */
function devCsp(): Plugin {
  return {
    name: 'iacleaner-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("connect-src 'self'", "connect-src 'self' ws: http://localhost:*")
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: { externalizeDeps: true }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: { externalizeDeps: true }
  },
  renderer: {
    resolve: {
      alias: { ...sharedAlias, '@renderer': resolve('src/renderer/src') }
    },
    plugins: [react(), tailwindcss(), devCsp()]
  }
})
