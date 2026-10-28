import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies the API and project files to a running `clap open --port 4300`.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:4300", "/p/": "http://127.0.0.1:4300" },
  },
});
