import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/files': 'http://localhost:8080',
      '/list': 'http://localhost:8080',
      '/health': 'http://localhost:8080',
      '/ai-detect': { target: 'http://localhost:8080', timeout: 120000, proxyTimeout: 120000 },
      '/yolo-stats': 'http://localhost:8080',
      '/yolo-export': { target: 'http://localhost:8080', timeout: 120000, proxyTimeout: 120000 },
      '/make-bak': 'http://localhost:8080',
      '/vision-page': { target: 'http://localhost:8080', timeout: 240000, proxyTimeout: 240000 },
      '/vision-page-zones': { target: 'http://localhost:8080', timeout: 300000, proxyTimeout: 300000 },
      '/restore-bak': 'http://localhost:8080',
    },
  },
});
