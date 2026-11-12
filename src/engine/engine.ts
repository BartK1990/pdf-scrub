/**
 * PDF engine: everything that touches the PDF lives here.
 *
 * It is a plain module (no DOM) so it runs in the browser Web Worker and
 * in Node tests with the same code. It is built on MuPDF (WebAssembly),
 * whose redaction removes the content under a rectangle (text, image pixels
 * and vector art) instead of drawing a box over it.
 */
import * as mupdf from "mupdf";
import type {
  Rect,
  Mark,
  PageInfo,
  PageObject,
  SearchHit,
  HiddenTextHit,
  DocReport,
  ExportOptions,
  ExportResult,
  OpenResult,
} from "./types.ts";

export * from "./types.ts";

type Char = { c: string; quad: mupdf.Quad | null; line: number };

const SAVE_OPTIONS = "garbage=deduplicate,compress,clean,sanitize,encrypt=none";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function quadToRect(q: mupdf.Quad): Rect {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return [...b] as Rect;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function clampRect(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

function openPdfDoc(bytes: Uint8Array, password?: string): mupdf.PDFDocument {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pdf = doc.asPDF();
  if (!pdf) throw new Error("Not a PDF document");
  if (pdf.needsPassword()) {
    if (!password || !pdf.authenticatePassword(password)) {
      pdf.destroy();
      throw new PasswordError(password ? "Wrong password" : "Password required");
    }
  }
  return pdf;
}

export class PasswordError extends Error {
  readonly code = "PASSWORD";
}

/** Walk a page's structured text and collect every character with its quad. */
function pageChars(page: mupdf.PDFPage): { text: string; chars: Char[] } {
  const st = page.toStructuredText("preserve-whitespace");
  const chars: Char[] = [];
  let line = -1;
  try {
    st.walk({
      beginLine() {
        line++;
      },
      onChar(c, _origin, _font, _size, quad) {
        chars.push({ c, quad, line });
      },
      endLine() {
        chars.push({ c: "\n", quad: null, line });
      },
    });
  } finally {
    st.destroy();
  }
  return { text: chars.map((ch) => ch.c).join(""), chars };
}

/* ------------------------------------------------------------------ */
/* Session: one opened document                                        */
/* ------------------------------------------------------------------ */

export class PdfSession {
  private original: Uint8Array;
  private password?: string;
  private doc: mupdf.PDFDocument;
  private result: mupdf.PDFDocument | null = null;
  private charCache = new Map<number, { text: string; chars: Char[] }>();

  private constructor(bytes: Uint8Array, doc: mupdf.PDFDocument, password?: string) {
    this.original = bytes;
    this.doc = doc;
    this.password = password;
  }

  static open(bytes: Uint8Array, password?: string): { session: PdfSession; info: OpenResult } {
    // Keep a private copy: callers may transfer or reuse their buffer.
    const copy = new Uint8Array(bytes);
    const doc = openPdfDoc(copy, password);
    const session = new PdfSession(copy, doc, password);
    return { session, info: { pages: session.pages(), report: session.report() } };
  }

  close() {
    this.doc.destroy();
    this.result?.destroy();
  }

  private docFor(which: "original" | "result"): mupdf.PDFDocument {
    if (which === "result") {
      if (!this.result) throw new Error("No result yet. Export first.");
      return this.result;
    }
    return this.doc;
  }

  pages(which: "original" | "result" = "original"): PageInfo[] {
    const doc = this.docFor(which);
    const out: PageInfo[] = [];
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      const b = page.getBounds();
      out.push({ index: i, width: b[2] - b[0], height: b[3] - b[1], x0: b[0], y0: b[1] });
      page.destroy();
    }
    return out;
  }

  /** Render a page to RGBA pixels at the given scale (1 = 72 dpi). */
  render(index: number, scale: number, which: "original" | "result" = "original") {
    const doc = this.docFor(which);
    const page = doc.loadPage(index);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    const w = pix.getWidth();
    const h = pix.getHeight();
    const rgb = pix.getPixels();
    const stride = pix.getStride();
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      let s = y * stride;
      let d = y * w * 4;
      for (let x = 0; x < w; x++) {
        rgba[d++] = rgb[s++];
        rgba[d++] = rgb[s++];
        rgba[d++] = rgb[s++];
        rgba[d++] = 255;
      }
    }
    pix.destroy();
    page.destroy();
    return { width: w, height: h, pixels: rgba };
  }

  /** Selectable objects on a page: text blocks, text lines and images. */
  objects(index: number): PageObject[] {
    const page = this.doc.loadPage(index);
    const st = page.toStructuredText("preserve-images,preserve-whitespace");
    const out: PageObject[] = [];
    let block: { rect: Rect; text: string } | null = null;
    let lineText = "";
    let lineRect: Rect | null = null;
    try {
      st.walk({
        onImageBlock(bbox, _t, image) {
          out.push({
            kind: "image",
            rect: clampRect(bbox as Rect),
            label: `Image ${image.getWidth()}×${image.getHeight()} px`,
          });
        },
        beginTextBlock(bbox) {
          block = { rect: clampRect(bbox as Rect), text: "" };
        },
        beginLine() {
          lineText = "";
          lineRect = null;
        },
        onChar(c, _o, _f, _s, quad) {
          lineText += c;
          lineRect = unionRect(lineRect, quadToRect(quad));
        },
        endLine() {
          if (lineRect && lineText.trim()) {
            out.push({ kind: "line", rect: lineRect, label: lineText.trim() });
          }
          if (block) block.text += lineText + "\n";
        },
        endTextBlock() {
          if (block && block.text.trim()) {
            out.push({ kind: "block", rect: block.rect, label: block.text.trim() });
          }
          block = null;
        },
      });
    } finally {
      st.destroy();
      page.destroy();
    }
    return out;
  }

  private chars(index: number) {
    let entry = this.charCache.get(index);
    if (!entry) {
      const page = this.doc.loadPage(index);
      entry = pageChars(page);
      page.destroy();
      this.charCache.set(index, entry);
    }
    return entry;
  }

  /**
   * Search all pages. `pattern` is a JS regular expression source when
   * `regex` is set, otherwise a literal string.
   */
  search(pattern: string, opts: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean } = {}): SearchHit[] {
    if (!pattern) return [];
    let src = opts.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (opts.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    const re = new RegExp(src, "gu" + (opts.caseSensitive ? "" : "i"));
    const hits: SearchHit[] = [];
    const n = this.doc.countPages();
    for (let p = 0; p < n; p++) {
      const { text, chars } = this.chars(p);
      // String indices are UTF-16 code units; chars[] is per code point.
      const cuToChar: number[] = [];
      chars.forEach((ch, i) => {
        for (let k = 0; k < ch.c.length; k++) cuToChar.push(i);
      });
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        const start = cuToChar[m.index];
        const end = cuToChar[m.index + m[0].length - 1];
        // One rectangle per line the match touches.
        const perLine = new Map<number, Rect>();
        for (let i = start; i <= end; i++) {
          const ch = chars[i];
          if (!ch.quad || !ch.c.trim()) continue;
          perLine.set(ch.line, unionRect(perLine.get(ch.line) ?? null, quadToRect(ch.quad)));
        }
        const rects = [...perLine.values()];
        if (rects.length) hits.push({ page: p, rects, text: m[0] });
      }
    }
    return hits;
  }

  /**
   * Text a human cannot see but an LLM will read: white/near-white text,
   * microscopic text, and text outside the visible page.
   */
  findHiddenText(): HiddenTextHit[] {
    const hits: HiddenTextHit[] = [];
    const n = this.doc.countPages();
    for (let p = 0; p < n; p++) {
      const page = this.doc.loadPage(p);
      const bounds = page.getBounds();
      const st = page.toStructuredText("preserve-whitespace");
      let run: { reason: HiddenTextHit["reason"]; text: string; rect: Rect | null } | null = null;
      const flush = () => {
        if (run && run.rect && run.text.trim()) {
          hits.push({ page: p, rects: [run.rect], text: run.text.trim(), reason: run.reason });
        }
        run = null;
      };
      try {
        st.walk({
          onChar(c, _o, _f, size, quad, color) {
            const r = quadToRect(quad);
            let reason: HiddenTextHit["reason"] | null = null;
            const light = color.length >= 3
              ? color.slice(0, 3).every((v) => v > 0.94)
              : color.length === 1
                ? color[0] > 0.94
                : color.length === 4 && color.every((v) => v < 0.06); // CMYK white
            if (r[2] < bounds[0] || r[0] > bounds[2] || r[3] < bounds[1] || r[1] > bounds[3]) reason = "off-page";
            else if (size < 3) reason = "tiny";
            else if (light) reason = "white";
            if (!reason) {
              flush();
              return;
            }
            if (!run || run.reason !== reason) {
              flush();
              run = { reason, text: "", rect: null };
            }
            run.text += c;
            run.rect = unionRect(run.rect, r);
          },
          endLine() {
            flush();
          },
        });
      } finally {
        st.destroy();
        page.destroy();
      }
    }
    return hits;
  }

  /** What could leak besides visible page content. */
  report(): DocReport {
    const doc = this.doc;
    const meta: Record<string, string> = {};
    for (const key of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]) {
      const v = doc.getMetaData("info:" + key);
      if (v) meta[key] = v;
    }
    const root = doc.getTrailer().get("Root");
    const hasXmp = !root.get("Metadata").isNull();
    const names = root.get("Names");
    const hasJs =
      !root.get("OpenAction").isNull() || !root.get("AA").isNull() || (!names.isNull() && !names.get("JavaScript").isNull());
    const attachments = Object.keys(doc.getEmbeddedFiles());
    const annotations: Record<string, number> = {};
    let links = 0;
    let widgets = 0;
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      for (const a of page.getAnnotations()) {
        const t = a.getType();
        annotations[t] = (annotations[t] ?? 0) + 1;
      }
      links += page.getLinks().length;
      widgets += page.getWidgets().length;
      page.destroy();
    }
    return {
      pageCount: n,
      metadata: meta,
      hasXmpMetadata: hasXmp,
      hasJavaScript: hasJs,
      attachments,
      annotations,
      links,
      formFields: widgets,
      encrypted: doc.needsPassword() || !doc.getTrailer().get("Encrypt").isNull(),
    };
  }

  /** Apply all marks and clean-up options and produce a new PDF. */
  export(marks: Mark[], opts: ExportOptions): ExportResult {
    const doc = openPdfDoc(this.original, this.password);
    try {
      const n = doc.countPages();
      // 1. Forms first, so that flattened field values can be redacted.
      // (bake() starts a new xref section, so fetch trailer/root afterwards.)
      if (opts.forms === "flatten") doc.bake(false, true);
      const trailer = doc.getTrailer();
      const root = trailer.get("Root");
      if (opts.forms === "flatten") root.delete("AcroForm");

      for (let i = 0; i < n; i++) {
        const page = doc.loadPage(i);
        if (opts.forms === "remove") for (const w of page.getWidgets()) page.deleteAnnotation(w);
        if (opts.removeAnnotations) {
          for (const a of page.getAnnotations()) if (a.getType() !== "Link") page.deleteAnnotation(a);
        }
        if (opts.removeLinks) for (const l of page.getLinks()) page.deleteLink(l);
        if (opts.removeJavaScript) page.getObject().delete("AA");
        page.destroy();
      }
      if (opts.forms === "remove") root.delete("AcroForm");

      // 2. Document-level clean-up.
      if (opts.removeAttachments) {
        for (const name of Object.keys(doc.getEmbeddedFiles())) doc.deleteEmbeddedFile(name);
      }
      if (opts.removeJavaScript) {
        root.delete("OpenAction");
        root.delete("AA");
        const names = root.get("Names");
        if (!names.isNull()) names.delete("JavaScript");
      }
      if (opts.stripMetadata) {
        trailer.delete("Info");
        root.delete("Metadata");
        root.delete("PieceInfo");
        for (let i = 0; i < n; i++) {
          const pobj = doc.findPage(i);
          pobj.delete("Metadata");
          pobj.delete("PieceInfo");
        }
      }

      // 3. Redactions: real content removal under each rectangle.
      const byPage = new Map<number, Mark[]>();
      for (const m of marks) {
        if (m.page < 0 || m.page >= n) continue;
        (byPage.get(m.page) ?? byPage.set(m.page, []).get(m.page)!).push(m);
      }
      let applied = 0;
      for (let i = 0; i < n; i++) {
        const pageMarks = byPage.get(i);
        const page = doc.loadPage(i);
        if (pageMarks?.length) {
          for (const m of pageMarks) {
            const annot = page.createAnnotation("Redact");
            annot.setRect(clampRect(m.rect));
            applied++;
          }
          page.applyRedactions(
            opts.blackBoxes,
            mupdf.PDFPage.REDACT_IMAGE_PIXELS,
            mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
            mupdf.PDFPage.REDACT_TEXT_REMOVE,
          );
        }
        // Whole-page passes that strip one kind of content only.
        if (opts.removeAllImages || opts.removeAllVectors) {
          const annot = page.createAnnotation("Redact");
          annot.setRect(page.getBounds());
          page.applyRedactions(
            false,
            opts.removeAllImages ? mupdf.PDFPage.REDACT_IMAGE_REMOVE : mupdf.PDFPage.REDACT_IMAGE_NONE,
            opts.removeAllVectors ? mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED : mupdf.PDFPage.REDACT_LINE_ART_NONE,
            mupdf.PDFPage.REDACT_TEXT_NONE,
          );
        }
        page.destroy();
      }

      // 4. Page deletion last, so mark page numbers stay valid above.
      const del = [...new Set(opts.deletePages)].filter((p) => p >= 0 && p < n).sort((a, b) => b - a);
      if (del.length >= n) throw new Error("Cannot delete every page.");
      for (const p of del) doc.deletePage(p);

      const buf = doc.saveToBuffer(SAVE_OPTIONS);
      const bytes = new Uint8Array(buf.asUint8Array());
      buf.destroy();

      this.result?.destroy();
      this.result = openPdfDoc(bytes);
      const text = PdfSession.extractText(this.result);
      return {
        bytes,
        text,
        redactionsApplied: applied,
        pagesRemoved: del.length,
        pageCount: this.result.countPages(),
        report: PdfSession.reportFor(this.result),
      };
    } finally {
      doc.destroy();
    }
  }

  private static reportFor(doc: mupdf.PDFDocument): DocReport {
    const tmp = Object.create(PdfSession.prototype) as PdfSession;
    (tmp as unknown as { doc: mupdf.PDFDocument }).doc = doc;
    return tmp.report();
  }

  /** Plain text per page: what an LLM will "see" when given the file. */
  static extractText(doc: mupdf.PDFDocument): string[] {
    const out: string[] = [];
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      const st = page.toStructuredText("preserve-whitespace");
      out.push(st.asText());
      st.destroy();
      page.destroy();
    }
    return out;
  }

  text(which: "original" | "result" = "original"): string[] {
    return PdfSession.extractText(this.docFor(which));
  }
}
