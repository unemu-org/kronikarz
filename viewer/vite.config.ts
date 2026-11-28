import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Keys match by prefix, first match wins: a longer path must come before its
// prefix (/vision-page-zones before /vision-page). Script routes: proxy
// timeout ≥ server timeout (SCRIPT_TIMEOUTS in server/index.js) + 2 × kill
// grace (5 s) + margin — a proxy abort closes the request, and the server
// then kills the job.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/files': 'http://localhost:8080',
      '/list': 'http://localhost:8080',
      '/health': 'http://localhost:8080',
      '/ai-detect': { target: 'http://localhost:8080', timeout: 140000, proxyTimeout: 140000 }, // server 110 s
      '/yolo-stats': 'http://localhost:8080',
      '/yolo-export': { target: 'http://localhost:8080', timeout: 140000, proxyTimeout: 140000 }, // server 110 s
      '/make-bak': 'http://localhost:8080',
      '/vision-page-zones': { target: 'http://localhost:8080', timeout: 320000, proxyTimeout: 320000 }, // server 290 s
      '/vision-page': { target: 'http://localhost:8080', timeout: 260000, proxyTimeout: 260000 }, // server 230 s
      '/restore-bak': 'http://localhost:8080',
      // POST /auto + GET /auto/status; server: 120 s × pages, capped at 3000 s
      '/auto': { target: 'http://localhost:8080', timeout: 3600000, proxyTimeout: 3600000 },
    },
  },
});
