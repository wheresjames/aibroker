import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/health": "http://aibroker-api:8080",
      "/admin": "http://aibroker-api:8080",
      "/me": "http://aibroker-api:8080",
      "/auth": "http://aibroker-api:8080"
    }
  }
});
