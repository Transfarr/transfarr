import { fileURLToPath, URL } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const proxy = {
  "/api": {
    target: "http://127.0.0.1:3000",
    changeOrigin: true,
    ws: true,
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  esbuild: {
    target: "safari14",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "safari14",
    },
  },
  server: {
    proxy,
  },
  preview: {
    proxy,
  },
  build: {
    target: "safari14",
    outDir: "../public",
    emptyOutDir: true,
  },
})
