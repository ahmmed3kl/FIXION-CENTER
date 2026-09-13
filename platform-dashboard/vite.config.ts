/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], server: { port: 5174 }, test: { environment: "jsdom", setupFiles: "./tests/setup.ts" } });
