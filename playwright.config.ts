import { defineConfig } from "@playwright/test";

// 端到端测试:对构建好的 dist/ 跑(先 npm run build)。OpenAI 的 WebSocket 和翻译接口都在页面里换成假的,不花钱
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 60_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:4173/",
    screenshot: "only-on-failure",
    launchOptions: {
      // 本机已有 Chromium 时可用 CHROMIUM_PATH 指定,省得下载 Playwright 自带的
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  webServer: {
    command: "npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173/",
    reuseExistingServer: !process.env.CI,
  },
});
