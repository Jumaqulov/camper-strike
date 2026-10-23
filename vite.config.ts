import { defineConfig } from 'vite';

// Dev rejimida Vite 5173-portda ishlaydi va socket.io so'rovlarini 3000-portdagi o'yin serveriga yo'naltiradi.
export default defineConfig({
  server: {
    host: true, // lokal tarmoqdagi boshqa kompyuterlar ham ulana olsin
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true },
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
