import { defineConfig } from "vite";

import { execSync } from "node:child_process";

// 设置页显示的版本:东京时间 + git 提交号(工作区有改动时带 +)
const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
const git = (cmd: string) => { try { return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
const sha = git("git rev-parse --short HEAD"), dirty = git("git status --porcelain") ? "+" : "";
const build = `${p.month}-${p.day} ${p.hour}:${p.minute} JST` + (sha ? ` · ${sha}${dirty}` : "");

export default defineConfig({
  base: "./",
  define: { __BUILD__: JSON.stringify(build) },
  // @ffmpeg/ffmpeg 的 worker 不能被预打包
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  build: { target: "es2022" },
});
