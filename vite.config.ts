import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

/*
  avataaars 只用得到 lodash.uniqueId，却 require 了整个 lodash。只把「从 avataaars
  里发出的」那一句换成 client/src/lib/avataaarsLodashShim.ts，别的依赖照常拿真 lodash。
  开发模式下依赖是 esbuild 预打包的、不走这里，用的仍是真 lodash —— 两边行为一致。
*/
function avataaarsLodashShim(): Plugin {
  const shim = path.resolve(__dirname, "./client/src/lib/avataaarsLodashShim.ts");
  return {
    name: "forwardx:avataaars-lodash-shim",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "lodash" && importer && /[\\/]avataaars[\\/]/.test(importer)) return shim;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [avataaarsLodashShim(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./client/src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  publicDir: "client/public",
  build: {
    outDir: "client/dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
