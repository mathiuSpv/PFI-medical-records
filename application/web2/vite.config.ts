import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import path from 'node:path'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// El proxy evita CORS: el front llama /api/* y Vite lo reenvía al BFF
// (application/server, puerto 3001). SSE funciona a través del proxy.
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    // 5174 y no 5173 para poder tener web (vieja) y web2 corriendo a la vez
    // mientras dura la migración.
    port: 5174,
    // Sin strictPort, si el puerto está ocupado Vite se muda a otro en silencio
    // y el navegador sigue hablando con la instancia vieja. Mejor que falle.
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3001',
    },
    watch: {
      // Sobre el bind mount de un devcontainer en Windows los eventos de
      // inotify no llegan y HMR nunca dispara. El polling lo resuelve pero
      // cuesta CPU, así que es opt-in: VITE_POLLING=1 npm run dev.
      usePolling: !!process.env.VITE_POLLING,
    },
  },
})
