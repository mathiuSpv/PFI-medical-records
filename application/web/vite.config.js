import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// El proxy evita CORS: el front llama /api/* y Vite lo reenvía al BFF
// (application/server, puerto 3001). SSE funciona a través del proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Sin strictPort, si el 5173 está ocupado Vite se muda a otro puerto y lo
    // dice en una línea del log que es fácil pasar por alto: el navegador sigue
    // hablando con la instancia vieja y parece que los cambios no se aplican.
    // Mejor que falle.
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3001',
    },
    watch: {
      // Sobre el bind mount de un devcontainer en Windows los eventos de
      // inotify no llegan: HMR nunca dispara y hay que reiniciar el server en
      // cada cambio. El polling lo resuelve, pero cuesta CPU, así que va
      // opt-in — quien lo necesite arranca con VITE_POLLING=1 npm run dev.
      usePolling: !!process.env.VITE_POLLING,
    },
  },
});
