import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// El proxy evita CORS: el front llama /api/* y Vite lo reenvía al BFF
// (application/server, puerto 3001). SSE funciona a través del proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
