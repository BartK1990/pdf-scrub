/// <reference lib="webworker" />
/**
 * Web Worker that owns the MuPDF engine. The heavy work (parsing,
 * rendering, redacting, saving) happens here so the page never freezes.
 */
import { PdfSession, PasswordError } from "./engine/engine.ts";
import type { Api } from "./api.ts";

let session: PdfSession | null = null;

function need(): PdfSession {
  if (!session) throw new Error("No document open");
  return session;
}

const api: Api = {
  open(bytes, password) {
    session?.close();
    session = null;
    const { session: s, info } = PdfSession.open(bytes, password);
    session = s;
    return info;
  },
  pages: (which) => need().pages(which),
  render: (index, scale, which) => need().render(index, scale, which),
  renderPreview: (index, scale, marks, opts) => need().renderPreview(index, scale, marks, opts),
  objects: (index) => need().objects(index),
  search: (pattern, opts) => need().search(pattern, opts),
  hidden: () => need().findHiddenText(),
  text: (which) => need().text(which),
  export: (marks, opts) => need().export(marks, opts),
  close() {
    session?.close();
    session = null;
  },
};

self.onmessage = async (e: MessageEvent<{ id: number; method: keyof Api; args: unknown[] }>) => {
  const { id, method, args } = e.data;
  try {
    const fn = api[method] as (...a: unknown[]) => unknown;
    const result = await fn(...args);
    const transfer: Transferable[] = [];
    if (result && typeof result === "object") {
      const r = result as { pixels?: Uint8ClampedArray; bytes?: Uint8Array };
      if (r.pixels) transfer.push(r.pixels.buffer as ArrayBuffer);
      // Export bytes are kept in the session for the result view, so copy instead.
    }
    (self as unknown as Worker).postMessage({ id, result }, transfer);
  } catch (err) {
    const code = err instanceof PasswordError ? "PASSWORD" : undefined;
    (self as unknown as Worker).postMessage({ id, error: { message: (err as Error)?.message ?? String(err), code } });
  }
};

(self as unknown as Worker).postMessage({ ready: true });
