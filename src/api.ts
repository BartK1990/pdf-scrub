/** Typed RPC between the UI thread and the engine worker. */
import type {
  ExportOptions,
  ExportResult,
  HiddenTextHit,
  Mark,
  OpenResult,
  PageInfo,
  PageObject,
  SearchHit,
} from "./engine/types.ts";

type Which = "original" | "result";

export interface Api {
  open(bytes: Uint8Array, password?: string): OpenResult;
  pages(which: Which): PageInfo[];
  render(index: number, scale: number, which: Which): { width: number; height: number; pixels: Uint8ClampedArray };
  objects(index: number): PageObject[];
  search(pattern: string, opts: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean }): SearchHit[];
  hidden(): HiddenTextHit[];
  text(which: Which): string[];
  export(marks: Mark[], opts: ExportOptions): ExportResult;
  close(): void;
}

export type Remote = { [K in keyof Api]: (...args: Parameters<Api[K]>) => Promise<ReturnType<Api[K]>> };

export class RpcError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export function connect(): { remote: Remote; ready: Promise<void> } {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let markReady: () => void;
  let failReady: (e: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    markReady = res;
    failReady = rej;
  });

  worker.onmessage = (e) => {
    const d = e.data;
    if (d.ready) return markReady();
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.error) p.reject(new RpcError(d.error.message, d.error.code));
    else p.resolve(d.result);
  };
  worker.onerror = (e) => {
    failReady(new Error(e.message || "The PDF engine failed to load."));
  };

  const remote = new Proxy({} as Remote, {
    get(_t, method: string) {
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, method, args });
        });
    },
  });
  return { remote, ready };
}
