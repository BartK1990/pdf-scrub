import "./style.css";
import { connect, RpcError } from "./api.ts";
import { PRESETS } from "./engine/presets.ts";
import {
  DEFAULT_EXPORT_OPTIONS,
  type DocReport,
  type ExportOptions,
  type ExportResult,
  type HiddenTextHit,
  type Mark,
  type MarkSource,
  type PageInfo,
  type PageObject,
  type Rect,
  type SearchHit,
} from "./engine/types.ts";

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const nodes = (...c: Child[]) => c.filter((x): x is Node | string => x !== null && x !== undefined && x !== false);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

type View = "original" | "result";
type Hit = (SearchHit | HiddenTextHit) & { key: string; source: MarkSource; tag?: string };

const state = {
  fileName: "",
  pages: [] as PageInfo[],
  resultPages: [] as PageInfo[],
  report: null as DocReport | null,
  marks: [] as Mark[],
  undo: [] as Mark[][],
  redo: [] as Mark[][],
  hits: [] as Hit[],
  mode: "draw" as "draw" | "pick",
  pickLevel: "line" as "line" | "block",
  zoom: 1,
  view: "original" as View,
  opts: structuredClone(DEFAULT_EXPORT_OPTIONS) as ExportOptions,
  deleted: new Set<number>(),
  result: null as ExportResult | null,
  busy: false,
  /** Show pages as they will look after export (deletions applied). */
  livePreview: true,
  /** Objects selected in Pick mode, waiting for Delete. */
  selection: new Map<string, Sel>(),
};

type Sel = { page: number; rect: Rect; label: string; kind: PageObject["kind"] };
const selKey = (page: number, o: PageObject) => `${page}:${o.kind}:${o.rect.map((v) => v.toFixed(1)).join(",")}`;

const objectsCache = new Map<number, PageObject[]>();
let markSeq = 0;
const newId = () => `m${++markSeq}`;

const { remote, ready } = connect();

/* ------------------------------------------------------------------ */
/* Marks with undo                                                     */
/* ------------------------------------------------------------------ */

function setMarks(next: Mark[]) {
  state.undo.push(state.marks);
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
  state.marks = next;
  marksChanged();
}
function addMarks(ms: Omit<Mark, "id">[]) {
  if (ms.length) setMarks([...state.marks, ...ms.map((m) => ({ ...m, id: newId() }))]);
}
function removeMark(id: string) {
  setMarks(state.marks.filter((m) => m.id !== id));
}
function undo() {
  const prev = state.undo.pop();
  if (!prev) return;
  state.redo.push(state.marks);
  state.marks = prev;
  marksChanged();
}
function redo() {
  const next = state.redo.pop();
  if (!next) return;
  state.undo.push(state.marks);
  state.marks = next;
  marksChanged();
}
function marksChanged() {
  invalidateResult();
  repaintRendered();
  renderAllOverlays();
  renderMarksPanel();
  renderToolbar();
}
function invalidateResult() {
  if (state.result) {
    state.result = null;
    if (state.view === "result") setView("original");
    renderToolbar();
  }
}

/* ------------------------------------------------------------------ */
/* Opening files                                                       */
/* ------------------------------------------------------------------ */

async function openFile(file: File) {
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    toast("That does not look like a PDF file.");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  setBusy(true, "Opening…");
  try {
    await ready;
    let password: string | undefined;
    for (;;) {
      try {
        const info = await remote.open(bytes, password);
        state.fileName = file.name;
        state.pages = info.pages;
        state.report = info.report;
        break;
      } catch (e) {
        if (e instanceof RpcError && e.code === "PASSWORD") {
          const p = prompt(password === undefined ? "This PDF is password-protected. Enter the password:" : "Wrong password. Try again:");
          if (p === null) return;
          password = p;
          continue;
        }
        throw e;
      }
    }
    Object.assign(state, {
      marks: [],
      undo: [],
      redo: [],
      hits: [],
      result: null,
      view: "original",
      resultPages: [],
      opts: structuredClone(DEFAULT_EXPORT_OPTIONS),
      deleted: new Set<number>(),
    });
    objectsCache.clear();
    state.selection.clear();
    document.body.dataset.screen = "editor";
    state.zoom = fitZoom();
    renderEditor();
  } catch (e) {
    toast(`Could not open the file: ${(e as Error).message}`);
  } finally {
    setBusy(false);
  }
}

function fitZoom(): number {
  const area = $("#pages");
  const w = (area?.clientWidth || 800) - 48;
  const maxW = Math.max(...state.pages.map((p) => p.width), 1);
  return Math.min(1.5, Math.max(0.4, +(w / maxW).toFixed(2)));
}

/* ------------------------------------------------------------------ */
/* Page rendering                                                      */
/* ------------------------------------------------------------------ */

let observer: IntersectionObserver | null = null;
/** What each canvas currently shows, so unchanged pages are not re-rendered. */
const renderedScale = new Map<string, string>();
const paintToken = new Map<number, number>();
let renderGen = 0;
let tokenSeq = 0;

const previewOpts = () => ({
  blackBoxes: state.opts.blackBoxes,
  removeAllImages: state.opts.removeAllImages,
  removeAllVectors: state.opts.removeAllVectors,
});

/** Marks + options that affect how one page looks after export. */
function pageSignature(index: number): string {
  if (state.view !== "original" || !state.livePreview) return "plain";
  const o = previewOpts();
  const marks = state.marks.filter((m) => m.page === index);
  if (!marks.length && !o.removeAllImages && !o.removeAllVectors) return "plain";
  return JSON.stringify([o, marks.map((m) => m.rect)]);
}

/** Re-render pages already on screen whose look changed. */
function repaintRendered() {
  for (const key of renderedScale.keys()) {
    const [view, idx] = key.split(":");
    if (view === state.view) void paintPage(Number(idx));
  }
}

function currentPages(): PageInfo[] {
  return state.view === "result" ? state.resultPages : state.pages;
}

function buildPages() {
  const host = $("#pages");
  host.replaceChildren();
  observer?.disconnect();
  renderedScale.clear();
  renderGen++;
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) void paintPage(Number((e.target as HTMLElement).dataset.page));
    },
    { root: host, rootMargin: "600px 0px" },
  );
  if (state.view === "result") {
    host.append(
      h(
        "div",
        { class: "result-banner" },
        h("strong", {}, "Previewing the cleaned PDF."),
        " This is the file you download. ",
        h("button", { class: "link", onclick: () => setView("original") }, "Back to editing"),
      ),
    );
  }
  for (const p of currentPages()) {
    const deleted = state.view === "original" && state.deleted.has(p.index);
    const wrap = h(
      "section",
      { class: "page" + (deleted ? " deleted" : ""), "data-page": String(p.index) },
      h(
        "header",
        { class: "page-head" },
        h("span", {}, `Page ${p.index + 1}`),
        state.view === "original" &&
          h(
            "button",
            {
              class: "chip small" + (deleted ? " on" : ""),
              title: deleted ? "Keep this page" : "Remove this whole page from the output",
              onclick: () => togglePageDelete(p.index),
            },
            deleted ? "Restore page" : "Delete page",
          ),
      ),
      h(
        "div",
        { class: "sheet", style: { width: `${p.width * state.zoom}px`, height: `${p.height * state.zoom}px` } },
        h("canvas", {}),
        h("div", { class: "overlay" }),
      ),
    );
    host.append(wrap);
    observer.observe(wrap);
    if (state.view === "original") renderOverlay(p.index);
  }
}

async function paintPage(index: number) {
  const key = `${state.view}:${index}`;
  const scale = state.zoom * (window.devicePixelRatio || 1);
  const sig = pageSignature(index);
  const want = `${scale}|${sig}`;
  if (renderedScale.get(key) === want) return;
  renderedScale.set(key, want);
  const gen = renderGen;
  const token = ++tokenSeq;
  paintToken.set(index, token);
  const view = state.view;
  try {
    const img =
      sig === "plain"
        ? await remote.render(index, scale, view)
        : await remote.renderPreview(index, scale, state.marks.filter((m) => m.page === index), previewOpts());
    // Drop stale answers: the page changed again while this one was rendering.
    if (gen !== renderGen || paintToken.get(index) !== token) return;
    const canvas = $(`#pages .page[data-page="${index}"] canvas`) as HTMLCanvasElement | null;
    if (!canvas) return;
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext("2d")!.putImageData(new ImageData(img.pixels as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  } catch (e) {
    renderedScale.delete(key);
    console.error(e);
  }
}

function setZoom(z: number) {
  const host = $("#pages");
  const ratio = host.scrollTop / Math.max(1, host.scrollHeight);
  state.zoom = Math.min(4, Math.max(0.25, +z.toFixed(2)));
  buildPages();
  host.scrollTop = ratio * host.scrollHeight;
  renderToolbar();
}

function setLivePreview(on: boolean) {
  state.livePreview = on;
  document.body.dataset.live = String(on);
  repaintRendered();
  renderAllOverlays();
  renderToolbar();
}

function setView(v: View) {
  if (v === "result" && !state.result) return;
  state.view = v;
  document.body.dataset.view = v;
  buildPages();
  renderToolbar();
}

function togglePageDelete(i: number) {
  if (state.deleted.has(i)) state.deleted.delete(i);
  else {
    if (state.deleted.size + 1 >= state.pages.length) return toast("At least one page has to stay.");
    state.deleted.add(i);
  }
  invalidateResult();
  const el = $(`#pages .page[data-page="${i}"]`);
  if (el) {
    el.classList.toggle("deleted", state.deleted.has(i));
    const btn = el.querySelector(".page-head button")!;
    btn.textContent = state.deleted.has(i) ? "Restore page" : "Delete page";
    btn.classList.toggle("on", state.deleted.has(i));
  }
  renderMarksPanel();
}

/* ------------------------------------------------------------------ */
/* Overlay: marks, search hits, pickable objects, drawing              */
/* ------------------------------------------------------------------ */

function pct(p: PageInfo, r: Rect) {
  return {
    left: `${((r[0] - p.x0) / p.width) * 100}%`,
    top: `${((r[1] - p.y0) / p.height) * 100}%`,
    width: `${((r[2] - r[0]) / p.width) * 100}%`,
    height: `${((r[3] - r[1]) / p.height) * 100}%`,
  };
}

function renderAllOverlays() {
  if (state.view !== "original") return;
  for (const p of state.pages) renderOverlay(p.index);
}

function renderOverlay(index: number) {
  const overlay = $(`#pages .page[data-page="${index}"] .overlay`);
  if (!overlay) return;
  const page = state.pages[index];
  overlay.replaceChildren();
  overlay.dataset.mode = state.mode;

  if (state.mode === "pick") {
    const objs = objectsCache.get(index);
    if (!objs) {
      void remote.objects(index).then((o) => {
        objectsCache.set(index, o);
        renderOverlay(index);
      });
    } else {
      const pageMarks = state.marks.filter((m) => m.page === index);
      for (const o of objs) {
        if (o.kind !== "image" && o.kind !== state.pickLevel) continue;
        // Already deleted: nothing left to pick there.
        if (pageMarks.some((m) => covers(m.rect, o.rect))) continue;
        const key = selKey(index, o);
        overlay.append(
          h("div", {
            class: `obj obj-${o.kind}` + (state.selection.has(key) ? " selected" : ""),
            title: `${o.kind === "image" ? "" : "Text: "}${o.label.slice(0, 200)}\nClick to select, Shift+click to add, Delete to remove`,
            style: pct(page, o.rect),
            onpointerdown: (e: PointerEvent) => {
              e.stopPropagation();
              toggleSelect(index, o, e.shiftKey || e.ctrlKey || e.metaKey);
            },
          }),
        );
      }
    }
  }

  for (const hit of state.hits) {
    if (hit.page !== index) continue;
    for (const r of hit.rects) {
      overlay.append(h("div", { class: "hit", style: pct(page, r), title: `Found: ${hit.text}` }));
    }
  }

  for (const m of state.marks) {
    if (m.page !== index) continue;
    overlay.append(
      h(
        "div",
        {
          class: `mark src-${m.source}` + (state.livePreview ? " live" : ""),
          style: pct(page, m.rect),
          title: `${m.label}\nClick to undo this redaction`,
          onpointerdown: (e: PointerEvent) => {
            e.stopPropagation();
            removeMark(m.id);
          },
        },
        h("span", { class: "x" }, "×"),
      ),
    );
  }
}

function covers(outer: Rect, inner: Rect) {
  const e = 1;
  return outer[0] <= inner[0] + e && outer[1] <= inner[1] + e && outer[2] >= inner[2] - e && outer[3] >= inner[3] - e;
}

function toggleSelect(page: number, o: PageObject, additive: boolean) {
  const key = selKey(page, o);
  const was = state.selection.has(key);
  const touched = new Set([page, ...[...state.selection.values()].map((x) => x.page)]);
  if (!additive) state.selection.clear();
  if (was && (additive || touched.size === 1)) state.selection.delete(key);
  else state.selection.set(key, { page, rect: o.rect, label: o.label, kind: o.kind });
  for (const p of touched) renderOverlay(p);
  renderToolbar();
}

function clearSelection() {
  if (!state.selection.size) return;
  const pages = new Set([...state.selection.values()].map((x) => x.page));
  state.selection.clear();
  for (const p of pages) renderOverlay(p);
  renderToolbar();
}

/** Delete key: turn the selected objects into redactions. */
function deleteSelection() {
  if (!state.selection.size) {
    if (state.mode === "pick") toast("Click objects on the page to select them first.");
    return;
  }
  const pad = 0.5;
  const sel = [...state.selection.values()];
  state.selection.clear();
  addMarks(
    sel.map((o) => ({
      page: o.page,
      rect: [o.rect[0] - pad, o.rect[1] - pad, o.rect[2] + pad, o.rect[3] + pad] as Rect,
      source: "object" as const,
      label: o.kind === "image" ? o.label : o.label.slice(0, 120),
    })),
  );
  toast(`Removed ${sel.length} object${sel.length > 1 ? "s" : ""}. Ctrl+Z to undo.`);
}

function setupDrawing() {
  const host = $("#pages");
  let drag: { page: PageInfo; sheet: HTMLElement; x0: number; y0: number; box: HTMLElement; pid: number } | null = null;

  const toPdf = (sheet: HTMLElement, page: PageInfo, cx: number, cy: number): [number, number] => {
    const r = sheet.getBoundingClientRect();
    const x = Math.min(Math.max(cx - r.left, 0), r.width);
    const y = Math.min(Math.max(cy - r.top, 0), r.height);
    return [page.x0 + (x / r.width) * page.width, page.y0 + (y / r.height) * page.height];
  };

  host.addEventListener("pointerdown", (e) => {
    if (state.view === "original" && state.mode === "pick" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if ((e.target as HTMLElement).closest(".overlay")) clearSelection();
      return;
    }
    if (state.view !== "original" || state.mode !== "draw" || e.button !== 0) return;
    const overlay = (e.target as HTMLElement).closest(".overlay") as HTMLElement | null;
    if (!overlay) return;
    const sheet = overlay.parentElement!;
    const index = Number(sheet.parentElement!.dataset.page);
    const page = state.pages[index];
    const [x, y] = toPdf(sheet, page, e.clientX, e.clientY);
    const box = h("div", { class: "mark drawing" });
    overlay.append(box);
    drag = { page, sheet, x0: x, y0: y, box, pid: e.pointerId };
    overlay.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  host.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const [x, y] = toPdf(drag.sheet, drag.page, e.clientX, e.clientY);
    Object.assign(drag.box.style, pct(drag.page, [Math.min(drag.x0, x), Math.min(drag.y0, y), Math.max(drag.x0, x), Math.max(drag.y0, y)]));
  });
  const finish = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag;
    drag = null;
    d.box.remove();
    const [x, y] = toPdf(d.sheet, d.page, e.clientX, e.clientY);
    const rect: Rect = [Math.min(d.x0, x), Math.min(d.y0, y), Math.max(d.x0, x), Math.max(d.y0, y)];
    if (rect[2] - rect[0] < 2 || rect[3] - rect[1] < 2) return;
    addMarks([{ page: d.page.index, rect, source: "area", label: `Area on page ${d.page.index + 1}` }]);
  };
  host.addEventListener("pointerup", finish);
  host.addEventListener("pointercancel", (e) => {
    if (drag && e.pointerId === drag.pid) {
      drag.box.remove();
      drag = null;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Find panel                                                          */
/* ------------------------------------------------------------------ */

const searchOpts = { caseSensitive: false, wholeWord: false, regex: false };

function setHits(hits: Hit[], append = false) {
  if (append) {
    const seen = new Set(state.hits.map((x) => x.key));
    state.hits = [...state.hits, ...hits.filter((x) => !seen.has(x.key))];
  } else state.hits = hits;
  renderHits();
  renderAllOverlays();
}

function hitKey(hh: SearchHit) {
  return `${hh.page}:${hh.rects.map((r) => r.map((v) => v.toFixed(1)).join(",")).join("|")}`;
}

async function runSearch() {
  const q = ($("#q") as HTMLInputElement).value;
  if (!q.trim()) return;
  try {
    const res = await remote.search(q, searchOpts);
    setHits(res.map((r) => ({ ...r, key: hitKey(r), source: "search" as const })));
    if (!res.length) toast("No matches.");
  } catch (e) {
    toast(`Search failed: ${(e as Error).message}`);
  }
}

async function runPreset(id: string) {
  const p = PRESETS.find((x) => x.id === id)!;
  const res = (await remote.search(p.pattern, { regex: true })).filter((r) => !p.validate || p.validate(r.text));
  setHits(res.map((r) => ({ ...r, key: hitKey(r), source: "preset" as const, tag: p.label })), true);
  toast(res.length ? `${p.label}: ${res.length} found` : `${p.label}: none found`);
}

async function runHidden() {
  const res = await remote.hidden();
  const why = { white: "white / invisible text", tiny: "microscopic text", "off-page": "text outside the page" };
  setHits(res.map((r) => ({ ...r, key: hitKey(r), source: "hidden" as const, tag: why[r.reason] })), true);
  toast(res.length ? `Hidden text: ${res.length} found` : "No hidden text found.");
}

function hitsToMarks(hits: Hit[]) {
  const existing = new Set(state.marks.map((m) => `${m.page}:${m.rect.map((v) => v.toFixed(1)).join(",")}`));
  const ms: Omit<Mark, "id">[] = [];
  for (const hit of hits)
    for (const r of hit.rects) {
      const rect: Rect = [r[0] - 0.5, r[1] - 0.5, r[2] + 0.5, r[3] + 0.5];
      const k = `${hit.page}:${rect.map((v) => v.toFixed(1)).join(",")}`;
      if (existing.has(k)) continue;
      existing.add(k);
      ms.push({ page: hit.page, rect, source: hit.source, label: hit.text });
    }
  addMarks(ms);
  const done = new Set(hits.map((x) => x.key));
  setHits(state.hits.filter((x) => !done.has(x.key)));
}

function scrollToPage(i: number) {
  $(`#pages .page[data-page="${i}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderHits() {
  const list = $("#hits");
  list.replaceChildren();
  if (!state.hits.length) {
    list.append(h("p", { class: "muted small" }, "Results appear here. Nothing is removed until you add it to the redaction list."));
    return;
  }
  list.append(
    h(
      "div",
      { class: "row between" },
      h("strong", {}, `${state.hits.length} found`),
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn small", onclick: () => setHits([]) }, "Dismiss"),
        h("button", { class: "btn small primary", onclick: () => hitsToMarks(state.hits) }, "Redact all"),
      ),
    ),
  );
  const ul = h("ul", { class: "list" });
  for (const hit of state.hits.slice(0, 500)) {
    ul.append(
      h(
        "li",
        {},
        h(
          "button",
          { class: "item", title: "Show on page", onclick: () => scrollToPage(hit.page) },
          h("span", { class: "item-text" }, hit.text),
          h("span", { class: "muted small" }, `p. ${hit.page + 1}${hit.tag ? " · " + hit.tag : ""}`),
        ),
        h("button", { class: "icon", title: "Redact this", onclick: () => hitsToMarks([hit]) }, "+"),
      ),
    );
  }
  list.append(ul);
}

/* ------------------------------------------------------------------ */
/* Marks + clean-up panel                                              */
/* ------------------------------------------------------------------ */

function renderMarksPanel() {
  const el = $("#marks");
  el.replaceChildren();
  const n = state.marks.length;
  el.append(
    h(
      "div",
      { class: "row between" },
      h("strong", {}, n ? `${n} redaction${n > 1 ? "s" : ""}` : "No redactions yet"),
      n > 0 && h("button", { class: "btn small", onclick: () => setMarks([]) }, "Clear all"),
    ),
  );
  if (!n) {
    el.append(h("p", { class: "muted small" }, "Drag on a page to remove an area, or switch to Pick, click text or images (Shift+click for more) and press Delete. Find works too."));
  } else {
    const ul = h("ul", { class: "list" });
    for (const m of [...state.marks].reverse().slice(0, 500)) {
      ul.append(
        h(
          "li",
          {},
          h(
            "button",
            { class: "item", onclick: () => scrollToPage(m.page) },
            h("span", { class: "item-text" }, m.label),
            h("span", { class: "muted small" }, `p. ${m.page + 1} · ${m.source}`),
          ),
          h("button", { class: "icon", title: "Remove from list", onclick: () => removeMark(m.id) }, "×"),
        ),
      );
    }
    el.append(ul);
  }
  if (state.deleted.size) {
    el.append(h("p", { class: "small warn" }, `${state.deleted.size} page(s) will be deleted: ${[...state.deleted].sort((a, b) => a - b).map((i) => i + 1).join(", ")}`));
  }
}

function renderCleanup() {
  const r = state.report!;
  const el = $("#cleanup");
  el.replaceChildren();
  const metaKeys = Object.keys(r.metadata);
  const annotTotal = Object.entries(r.annotations).filter(([t]) => t !== "Link" && t !== "Widget").reduce((s, [, v]) => s + v, 0);

  const check = (key: keyof ExportOptions, title: string, found: string, risky: boolean) =>
    h(
      "label",
      { class: "opt" + (risky ? " risky" : "") },
      h("input", {
        type: "checkbox",
        checked: Boolean(state.opts[key]),
        onchange: (e: Event) => {
          (state.opts as unknown as Record<string, unknown>)[key] = (e.target as HTMLInputElement).checked;
          invalidateResult();
          repaintRendered();
        },
      }),
      h("span", {}, h("span", { class: "opt-title" }, title), h("span", { class: "opt-found" }, found)),
    );

  el.append(
    check(
      "stripMetadata",
      "Remove document metadata",
      metaKeys.length || r.hasXmpMetadata
        ? `Found: ${metaKeys.map((k) => `${k}: ${r.metadata[k].length > 40 ? r.metadata[k].slice(0, 40) + "…" : r.metadata[k]}`).join(" · ")}${r.hasXmpMetadata ? " · XMP block" : ""}`
        : "None found",
      metaKeys.length > 0 || r.hasXmpMetadata,
    ),
    check("removeJavaScript", "Remove JavaScript and auto-run actions", r.hasJavaScript ? "Found scripts or actions" : "None found", r.hasJavaScript),
    check("removeAttachments", "Remove embedded files", r.attachments.length ? `Found: ${r.attachments.join(", ")}` : "None found", r.attachments.length > 0),
    check("removeAnnotations", "Remove comments and annotations", annotTotal ? `Found: ${annotTotal}` : "None found", annotTotal > 0),
    check("removeLinks", "Remove links", r.links ? `Found: ${r.links}` : "None found", false),
    h(
      "label",
      { class: "opt" },
      h(
        "select",
        {
          onchange: (e: Event) => {
            state.opts.forms = (e.target as HTMLSelectElement).value as ExportOptions["forms"];
            invalidateResult();
          },
        },
        ...(["flatten", "remove", "keep"] as const).map((v) =>
          h("option", { value: v, selected: state.opts.forms === v }, { flatten: "Flatten", remove: "Remove", keep: "Keep" }[v]),
        ),
      ),
      h("span", {}, h("span", { class: "opt-title" }, "Form fields"), h("span", { class: "opt-found" }, r.formFields ? `Found: ${r.formFields}. Flatten keeps the filled-in values as page content you can redact.` : "None found")),
    ),
    h("hr", {}),
    check("removeAllImages", "Remove all images", "Every picture on every page", false),
    check("removeAllVectors", "Remove all vector graphics", "Lines, shapes, charts, logos drawn as vectors", false),
    check("blackBoxes", "Draw black boxes over redactions", "Off: the removed areas become blank", false),
  );
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

async function doExport() {
  setBusy(true, "Removing content…");
  try {
    const t0 = performance.now();
    const res = await remote.export(state.marks, { ...state.opts, deletePages: [...state.deleted] });
    state.result = res;
    state.resultPages = await remote.pages("result");
    renderToolbar();
    showResultDialog(res, performance.now() - t0);
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`);
  } finally {
    setBusy(false);
  }
}

function outName(ext: string) {
  return state.fileName.replace(/\.pdf$/i, "") + "-clean." + ext;
}

function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function verify(res: ExportResult): string[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  const out = norm(res.text.join(" "));
  const leaks = new Set<string>();
  for (const m of state.marks) {
    if (m.source === "area" || m.source === "object") continue;
    const t = norm(m.label).trim();
    if (t.length >= 3 && out.includes(t)) leaks.add(m.label);
  }
  return [...leaks];
}

function showResultDialog(res: ExportResult, ms: number) {
  const leaks = verify(res);
  const text = res.text.map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}`).join("\n\n");
  const size = res.bytes.byteLength;
  const dlg = h(
    "dialog",
    { class: "result" },
    h(
      "div",
      { class: "dialog-head" },
      h("h2", {}, "Your cleaned PDF is ready"),
      h("button", { class: "icon", title: "Close", onclick: () => dlg.close() }, "×"),
    ),
    h(
      "ul",
      { class: "stats" },
      h("li", {}, h("b", {}, String(res.redactionsApplied)), " areas removed"),
      h("li", {}, h("b", {}, String(res.pageCount)), ` pages${res.pagesRemoved ? ` (${res.pagesRemoved} deleted)` : ""}`),
      h("li", {}, h("b", {}, size > 1e6 ? `${(size / 1e6).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`), " file size"),
      h("li", {}, h("b", {}, `${(ms / 1000).toFixed(1)} s`), " processing"),
    ),
    leaks.length
      ? h("p", { class: "warn" }, `Check these: still found in the text of the output: ${leaks.join(", ")}. The same text probably appears elsewhere too. Search for it and redact every occurrence.`)
      : h("p", { class: "ok" }, "✓ Checked: none of the redacted text can be extracted from the new file."),
    h(
      "div",
      { class: "row wrap" },
      h("button", { class: "btn primary", onclick: () => download(res.bytes as Uint8Array<ArrayBuffer>, outName("pdf"), "application/pdf") }, "Download PDF"),
      h("button", { class: "btn", onclick: () => download(text, outName("txt"), "text/plain") }, "Download text"),
      h(
        "button",
        {
          class: "btn",
          onclick: async () => {
            await navigator.clipboard.writeText(text);
            toast("Text copied to the clipboard.");
          },
        },
        "Copy text",
      ),
      h(
        "button",
        {
          class: "btn",
          onclick: () => {
            dlg.close();
            setView("result");
          },
        },
        "Preview pages",
      ),
    ),
    h("h3", {}, "What an AI tool will read from this file"),
    h("p", { class: "muted small" }, "The text an LLM extracts from the new PDF. Check that nothing sensitive is left."),
    h("pre", { class: "text-preview" }, text || "(no text: the PDF contains only images)"),
  );
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function renderToolbar() {
  const tb = $("#toolbar");
  tb.replaceChildren(...nodes(
    h(
      "div",
      { class: "seg", role: "group", "aria-label": "Tool" },
      h("button", { class: state.mode === "draw" ? "on" : "", title: "Drag a rectangle to remove everything under it (D)", onclick: () => setMode("draw") }, "▭ Draw area"),
      h("button", { class: state.mode === "pick" ? "on" : "", title: "Click text lines, paragraphs or images to remove them (P)", onclick: () => setMode("pick") }, "⌖ Pick objects"),
    ),
    state.mode === "pick" &&
      h(
        "div",
        { class: "seg", role: "group", "aria-label": "Pick level" },
        h("button", { class: state.pickLevel === "line" ? "on" : "", onclick: () => setPickLevel("line") }, "Lines"),
        h("button", { class: state.pickLevel === "block" ? "on" : "", onclick: () => setPickLevel("block") }, "Paragraphs"),
      ),
    state.mode === "pick" &&
      h(
        "button",
        { class: "btn small danger", disabled: !state.selection.size, title: "Remove the selected objects (Delete)", onclick: deleteSelection },
        `Delete${state.selection.size ? ` (${state.selection.size})` : ""}`,
      ),
    h(
      "div",
      { class: "seg" },
      h("button", { title: "Undo (Ctrl+Z)", disabled: !state.undo.length, onclick: undo }, "↶"),
      h("button", { title: "Redo (Ctrl+Shift+Z)", disabled: !state.redo.length, onclick: redo }, "↷"),
    ),
    h(
      "div",
      { class: "seg" },
      h("button", { title: "Zoom out", onclick: () => setZoom(state.zoom / 1.2) }, "−"),
      h("button", { title: "Fit width", onclick: () => setZoom(fitZoom()) }, `${Math.round(state.zoom * 100)}%`),
      h("button", { title: "Zoom in", onclick: () => setZoom(state.zoom * 1.2) }, "+"),
    ),
    state.view === "original" &&
      h(
        "div",
        { class: "seg", role: "group", "aria-label": "Page display" },
        h("button", { class: !state.livePreview ? "on" : "", title: "Show the original pages with redactions outlined (V)", onclick: () => setLivePreview(false) }, "Original"),
        h("button", { class: state.livePreview ? "on" : "", title: "Show pages as they will look after export (V)", onclick: () => setLivePreview(true) }, "After deletion"),
      ),
    h("span", { class: "grow" }),
    state.result &&
      h(
        "div",
        { class: "seg" },
        h("button", { class: state.view === "original" ? "on" : "", onclick: () => setView("original") }, "Edit"),
        h("button", { class: state.view === "result" ? "on" : "", onclick: () => setView("result") }, "Result"),
      ),
    h("button", { class: "btn primary", onclick: doExport, disabled: state.busy }, state.result ? "Export again" : "Apply & export"),
  ));
}

function setMode(m: "draw" | "pick") {
  state.mode = m;
  if (m !== "pick") state.selection.clear();
  if (state.view !== "original") setView("original");
  renderToolbar();
  renderAllOverlays();
}
function setPickLevel(l: "line" | "block") {
  state.pickLevel = l;
  renderToolbar();
  renderAllOverlays();
}

function renderEditor() {
  $("#doc-name").textContent = state.fileName;
  document.body.dataset.view = state.view;
  document.body.dataset.live = String(state.livePreview);
  renderToolbar();
  buildPages();
  renderHits();
  renderMarksPanel();
  renderCleanup();
}

function buildShell() {
  const app = $("#app");
  const fileInput = h("input", {
    type: "file",
    accept: "application/pdf,.pdf",
    hidden: true,
    onchange: (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) void openFile(f);
      (e.target as HTMLInputElement).value = "";
    },
  });
  const pick = () => fileInput.click();

  app.append(
    fileInput,
    h(
      "header",
      { class: "topbar" },
      h("a", { class: "brand", href: "./" }, h("span", { class: "logo", "aria-hidden": "true" }, "▚"), "PDF Scrub"),
      h("span", { id: "doc-name", class: "doc-name" }),
      h("span", { class: "grow" }),
      h("span", { class: "badge", title: "No server: your file is processed in this browser tab and is never uploaded." }, "🔒 Stays on your device"),
      h("button", { class: "btn small editor-only", onclick: pick }, "Open another PDF"),
    ),
    // Landing
    h(
      "main",
      { class: "landing" },
      h("h1", {}, "Clean a PDF before you give it to AI"),
      h(
        "p",
        { class: "lead" },
        "Remove names, numbers, images, hidden text and metadata from a PDF, then download a clean copy that is safe to paste into ChatGPT, Claude, Gemini or any other LLM.",
      ),
      h(
        "div",
        {
          class: "drop",
          tabindex: "0",
          role: "button",
          onclick: pick,
          onkeydown: (e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && pick(),
        },
        h("div", { class: "drop-icon", "aria-hidden": "true" }, "⇪"),
        h("strong", {}, "Drop a PDF here or click to choose one"),
        h("span", { class: "muted" }, "Your file is processed in this browser. It is never uploaded."),
      ),
      h(
        "div",
        { class: "features" },
        feature("Removes the content, not just hides it", "Black boxes in most editors leave the text underneath. Here the text, image pixels and drawings are deleted from the file."),
        feature("Finds what you might miss", "E-mails, phone numbers, IBANs, card numbers and dates. Also white or microscopic text, a common way to hide prompt-injection text from people."),
        feature("Shows what the AI will read", "After export you see the exact text an LLM extracts from the new file, and a check that nothing you redacted is left."),
        feature("Private by design", "A static page with no backend, no analytics and no uploads. Its security policy stops the browser from sending your file anywhere."),
      ),
    ),
    // Editor
    h(
      "div",
      { class: "editor" },
      h("div", { id: "toolbar", class: "toolbar" }),
      h(
        "aside",
        { class: "panel left" },
        h("h2", {}, "Find"),
        h(
          "form",
          {
            class: "search",
            onsubmit: (e: Event) => {
              e.preventDefault();
              void runSearch();
            },
          },
          h("input", { id: "q", type: "search", placeholder: "Find text, e.g. a name", autocomplete: "off" }),
          h("button", { class: "btn primary small", type: "submit" }, "Find"),
        ),
        h(
          "div",
          { class: "row toggles" },
          toggle("Aa", "Match case", "caseSensitive"),
          toggle("Word", "Whole words only", "wholeWord"),
          toggle(".*", "Regular expression", "regex"),
        ),
        h("h3", {}, "Detect"),
        h(
          "div",
          { class: "chips" },
          ...PRESETS.map((p) => h("button", { class: "chip", onclick: () => void runPreset(p.id) }, p.label)),
          h("button", { class: "chip accent", title: "White, microscopic or off-page text: invisible to people, read by LLMs", onclick: () => void runHidden() }, "Hidden text"),
        ),
        h("div", { id: "hits", class: "hits" }),
      ),
      h("div", { id: "pages", class: "pages" }),
      h(
        "aside",
        { class: "panel right" },
        h("h2", {}, "Redactions"),
        h("div", { id: "marks" }),
        h("h2", {}, "Clean-up"),
        h("div", { id: "cleanup", class: "cleanup" }),
      ),
    ),
    h(
      "footer",
      { class: "foot landing-only" },
      "Open source. Built on ",
      h("a", { href: "https://mupdf.com/", rel: "noopener" }, "MuPDF"),
      " (AGPL-3.0) compiled to WebAssembly. ",
      h("a", { href: "https://github.com/", id: "repo-link", rel: "noopener" }, "Source code"),
    ),
    h("div", { id: "busy", class: "busy", hidden: true }, h("div", { class: "spinner" }), h("span", { id: "busy-text" })),
    h("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" }),
  );

  // Drag & drop anywhere.
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
  });
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) document.body.classList.remove("dragging");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    const f = e.dataTransfer?.files?.[0];
    if (f) void openFile(f);
  });

  window.addEventListener("keydown", (e) => {
    if (document.body.dataset.screen !== "editor") return;
    const t = e.target as HTMLElement;
    if (t.matches("input, textarea, select")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      renderToolbar();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
      renderToolbar();
    } else if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === "Escape") clearSelection();
    else if (!mod && e.key === "v") setLivePreview(!state.livePreview);
    else if (!mod && e.key === "d") setMode("draw");
    else if (!mod && e.key === "p") setMode("pick");
    else if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      $("#q").focus();
    }
  });

  let rt = 0;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = window.setTimeout(() => state.pages.length && renderToolbar(), 150);
  });

  setupDrawing();
}

function feature(title: string, body: string) {
  return h("div", { class: "feature" }, h("h3", {}, title), h("p", {}, body));
}

function toggle(label: string, title: string, key: keyof typeof searchOpts) {
  return h(
    "button",
    {
      class: "chip small",
      title,
      "aria-pressed": String(searchOpts[key]),
      onclick: (e: Event) => {
        searchOpts[key] = !searchOpts[key];
        (e.currentTarget as HTMLElement).setAttribute("aria-pressed", String(searchOpts[key]));
      },
    },
    label,
  );
}

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

function setBusy(on: boolean, text = "") {
  state.busy = on;
  const el = $("#busy");
  el.hidden = !on;
  $("#busy-text").textContent = text;
  if (state.pages.length) renderToolbar();
}

let toastTimer = 0;
function toast(msg: string) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 3500);
}

/* ------------------------------------------------------------------ */

document.body.dataset.screen = "landing";
buildShell();
const repo = import.meta.env.VITE_REPO_URL as string | undefined;
if (repo) ($("#repo-link") as HTMLAnchorElement).href = repo;
ready.catch((e) => toast(String(e.message ?? e)));
