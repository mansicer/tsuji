// 说话人识别用的 CAM++ 声纹模型(3D-Speaker,sherpa-onnx 转的 onnx,28 MB)不进 git:
// 构建前下载到 public/models/,和页面同源发布(不依赖外部 CDN,国内也能用)。已存在且校验通过就跳过。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const FILE = "public/models/campplus.onnx";
const URLS = [
  "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
];
const SHA256 = "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11";
const sha = (b) => createHash("sha256").update(b).digest("hex");

if (existsSync(FILE) && sha(readFileSync(FILE)) === SHA256) process.exit(0);
mkdirSync("public/models", { recursive: true });
for (const url of URLS) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha(buf) !== SHA256) throw new Error("sha256 不符");
    writeFileSync(FILE, buf);
    console.log(`${FILE} ← ${new URL(url).host}`);
    process.exit(0);
  } catch (e) {
    console.warn(`下载失败 ${url}: ${e.message}`);
  }
}
console.error("CAM++ 模型下载失败,说话人识别将不可用");
process.exit(1);
