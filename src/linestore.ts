// 字幕记录的持久化。localStorage 每个站点只有约 5 MB,会话多了会写满,所以存 IndexedDB;
// 启动时全部读进内存,读取保持同步(切换会话、导出时不用等)。写入失败交给 onError 提示用户。

/** 存储里的一行字幕(字段见 main.ts 的 saveLines) */
export interface SavedLine { id: number; raw?: string; src?: string; tgt?: string; t?: number; done?: boolean; [k: string]: unknown }

/** 键值存储后端:IndexedDB,不可用时退回 localStorage */
export interface KV {
  entries(prefix: string): Promise<[string, unknown][]>;
  put(key: string, value: unknown): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

const PREFIX = "lines:";

export class LineStore {
  private cache = new Map<string, SavedLine[]>();
  constructor(private kv: KV, private onError: (e: unknown) => void) {}

  async load(): Promise<void> {
    for (const [k, v] of await this.kv.entries(PREFIX)) if (Array.isArray(v)) this.cache.set(k.slice(PREFIX.length), v);
  }

  has(id: string): boolean { return this.cache.has(id); }
  /** 返回副本:调用方改数组不会让缓存和后端悄悄分叉 */
  get(id: string): SavedLine[] { return [...(this.cache.get(id) || [])]; }

  /** 空数组或 null 表示删除。缓存立即更新;返回后端是否写成功 */
  set(id: string, lines: SavedLine[] | null): Promise<boolean> {
    const write = lines && lines.length ? (this.cache.set(id, [...lines]), this.kv.put(PREFIX + id, lines)) : (this.cache.delete(id), this.kv.del(PREFIX + id));
    return write.then(() => true, (e) => (this.onError(e), false));
  }
}

/** 会话切走后才回来的翻译结果:按 id 写回那个会话存着的行 */
export function patchTranslations(saved: SavedLine[], items: { id: number; src: string; tgt: string }[]): SavedLine[] {
  const byId = new Map(items.map((it) => [it.id, it]));
  return saved.map((l) => {
    const it = byId.get(l.id);
    return it ? { ...l, src: it.src.trim(), tgt: it.tgt.trim(), done: true } : l;
  });
}

/**
 * 迁移后又用旧版记的字幕(旧版只认 localStorage):接在现有记录后面。
 * 旧版那边从 id 1 重新编号,所以 id 顺延;同一行(时间和原文都相同)已经有了就跳过
 */
export function mergeLegacy(current: SavedLine[], legacy: SavedLine[]): SavedLine[] {
  if (!current.length) return legacy;
  const key = (l: SavedLine) => `${l.t}|${l.raw}`;
  const seen = new Set(current.map(key));
  let next = current.reduce((m, l) => Math.max(m, l.id || 0), 0);
  const added = legacy.filter((l) => !seen.has(key(l))).map((l) => ({ ...l, id: ++next }));
  return added.length ? [...current, ...added] : current;
}
