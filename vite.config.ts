import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// The Web Audio worklet only exists in a secure context. Opening the dev
// server on a LAN address (or on a phone) is not one, so `npm run dev:secure`
// serves the same app over HTTPS with a self-signed certificate.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'secure' ? [basicSsl()] : [],
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
}));
