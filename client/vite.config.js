import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['node-seal'] },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:3000', rewrite: path => path.replace(/^\/api/, '') } } },
})
