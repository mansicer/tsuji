// 各功能都用的 DOM 小工具

/** querySelector 的简写。返回 any:调用方按元素类型直接读写 value / checked / hidden 等 */
export const $ = (s: string): any => document.querySelector(s);

/** 建元素:props 直接赋到元素上(className、textContent、onclick、style 字符串等),子节点里的 null / undefined 跳过 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props); e.append(...(kids.filter((k) => k != null) as (Node | string)[])); return e;
}

/** 在识别中间结果那一行红字提示 4 秒 */
export function flash(msg: string): void { const p = $("#partial"); p.textContent = msg; p.style.color = "var(--bad)"; setTimeout(() => (p.style.color = ""), 4000); }

/** 按钮文字临时换成提示,2 秒后恢复 */
export function flashBtn(b: HTMLElement, text: string): void { const old = b.textContent; b.textContent = text; setTimeout(() => (b.textContent = old), 2000); }

/** 把文本存成文件下载 */
export function download(name: string, text: string, type = "text/plain"): void {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
