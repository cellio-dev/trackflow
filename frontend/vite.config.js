import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        // Library/Plex scans and other settings "Run job" calls can run for minutes.
        timeout: 3_600_000,
        proxyTimeout: 3_600_000,
      },
    },
  },
  build: {
    // es2022+ enables top-level await in esbuild’s final transpile step
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        following: resolve(__dirname, 'following.html'),
        requests: resolve(__dirname, 'requests.html'),
        artist: resolve(__dirname, 'artist.html'),
        album: resolve(__dirname, 'album.html'),
        playlist: resolve(__dirname, 'playlist.html'),
        settings: resolve(__dirname, 'settings.html'),
        'manual-import': resolve(__dirname, 'manual-import.html'),
        login: resolve(__dirname, 'login.html'),
      },
    },
  },
});
