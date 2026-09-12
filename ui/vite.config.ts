import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "path";

export default defineConfig({
  plugins: [svelte(), viteSingleFile()],
  build: {
    outDir: path.resolve(__dirname, "../dist"),
    emptyOutDir: true,
    target: "esnext",
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
  },
  server: {
    proxy: {
      "/v1": "http://localhost:20129",
      "/api": "http://localhost:20129",
    },
  },
});
