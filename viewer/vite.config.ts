import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/files': 'http://localhost:8080',
      '/list': 'http://localhost:8080',
      '/health': 'http://localhost:8080',
    },
  },
});
