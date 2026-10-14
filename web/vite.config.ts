import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// In dev, proxy API + websocket to the backend so the browser sees one origin (no CORS setup needed).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: {
    '/api': 'http://localhost:3000',
    '/socket.io': { target: 'http://localhost:3000', ws: true },
  } },
});
