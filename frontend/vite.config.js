import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, path.resolve(root, ".."), "ASH_"), ...process.env };
  const backend = `http://127.0.0.1:${env.ASH_SERVER_PORT || 5050}`;
  return {
    root,
    plugins: [react()],
    css: {
      postcss: {
        plugins: [
          tailwindcss({
            content: [path.join(root, "index.html"), path.join(root, "src/**/*.{js,jsx}")],
            theme: {
              extend: { fontFamily: { sans: ["Manrope", "sans-serif"], display: ["Space Grotesk", "sans-serif"] } },
            },
          }),
          autoprefixer(),
        ],
      },
    },
    build: { outDir: "../dist/web", emptyOutDir: true, target: "es2022", assetsInlineLimit: 0 },
    server: {
      host: "127.0.0.1",
      port: Number(env.ASH_WEB_DEV_PORT || 5051),
      strictPort: true,
      proxy: {
        "/api": backend,
        "/console": backend,
        "/workspace/controls": backend,
        "/assets": backend,
      },
    },
  };
});
