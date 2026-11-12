import "./style.css";
import { connect, RpcError } from "./api.ts";
import { PRESETS } from "./engine/presets.ts";
import { ICONS, LOGO, SITE, formatCount } from "./site.ts";
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
  mode: "pick" as "draw" | "pick",
  pickLevel: "line" as "line" | "block",
  zoom: 1,
  zoomMode: "fit-width" as ZoomMode,
  currentPage: 0,
  thumbs: loadPref("thumbs", window.innerWidth >= 1280),
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

type ZoomMode = "fit-width" | "fit-page" | "custom";

function loadPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem("pdfscrub:" + key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function savePref(key: string, v: boolean) {
  try {
    localStorage.setItem("pdfscrub:" + key, v ? "1" : "0");
  } catch {
    /* storage unavailable: keep the in-memory value */
  }
}

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
    document.body.dataset.thumbs = String(state.thumbs);
    state.zoomMode = "fit-width";
    state.currentPage = 0;
    state.zoom = fitZoom("fit-width");
    renderEditor();
    $("#pages").scrollTo(0, 0);
    $("#pages").focus({ preventScroll: true });
  } catch (e) {
    toast(`Could not open the file: ${(e as Error).message}`);
  } finally {
    setBusy(false);
  }
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 6;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +z.toFixed(3)));

function fitZoom(mode: "fit-width" | "fit-page"): number {
  const host = $("#pages");
  const pages = currentPages().length ? currentPages() : state.pages;
  const w = (host?.clientWidth || 800) - 48;
  const hgt = (host?.clientHeight || 600) - 64;
  const maxW = Math.max(...pages.map((p) => p.width), 1);
  const maxH = Math.max(...pages.map((p) => p.height), 1);
  const z = mode === "fit-page" ? Math.min(w / maxW, hgt / maxH) : w / maxW;
  return clampZoom(Math.min(z, 3));
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

function fetchImage(index: number, scale: number, view: View, sig: string) {
  return sig === "plain"
    ? remote.render(index, scale, view)
    : remote.renderPreview(index, scale, state.marks.filter((m) => m.page === index), previewOpts());
}

/** Re-render pages already on screen whose look changed. */
function repaintRendered() {
  repaintThumbs();
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
  buildThumbs();
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
    const img = await fetchImage(index, scale, view, sig);
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

/* ------------------------------------------------------------------ */
/* Zoom and navigation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Zoom without rebuilding the pages: resize the sheets in place, keep the
 * point under `anchor` (client coordinates) where it was, stretch the
 * existing canvases right away and re-render them sharp once zooming pauses.
 */
function zoomTo(z: number, anchor?: { x: number; y: number }, mode: ZoomMode = "custom") {
  const host = $("#pages");
  if (!host) return;
  z = clampZoom(z);
  const hr = host.getBoundingClientRect();
  const ax = anchor ? anchor.x : hr.left + host.clientWidth / 2;
  const ay = anchor ? anchor.y : hr.top + host.clientHeight / 2;

  // Remember where the anchor sits relative to the page under it.
  const sheets = [...host.querySelectorAll<HTMLElement>(".sheet")];
  let ref: HTMLElement | null = null;
  let fx = 0.5;
  let fy = 0;
  for (const sh of sheets) {
    const r = sh.getBoundingClientRect();
    if (r.bottom >= ay || sh === sheets[sheets.length - 1]) {
      ref = sh;
      fx = (ax - r.left) / r.width;
      fy = (ay - r.top) / r.height;
      break;
    }
  }

  state.zoom = z;
  state.zoomMode = mode;
  const pages = currentPages();
  for (const sh of sheets) {
    const p = pages.find((x) => x.index === Number(sh.parentElement!.dataset.page));
    if (!p) continue;
    sh.style.width = `${p.width * z}px`;
    sh.style.height = `${p.height * z}px`;
  }
  if (ref) {
    const r = ref.getBoundingClientRect();
    host.scrollLeft += r.left + fx * r.width - ax;
    host.scrollTop += r.top + fy * r.height - ay;
  }
  updateZoomControl();
  scheduleSharpen();
}

function zoomStep(dir: 1 | -1, anchor?: { x: number; y: number }) {
  const z = state.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z * 1.01) ?? z * 1.25 : [...ZOOM_STEPS].reverse().find((s) => s < z / 1.01) ?? z / 1.25;
  zoomTo(next, anchor);
}

function zoomFit(mode: "fit-width" | "fit-page") {
  const page = state.currentPage;
  zoomTo(fitZoom(mode), undefined, mode);
  goToPage(page, false);
}

let sharpenTimer = 0;
/** After zooming pauses, re-render the pages in view at the new scale. */
function scheduleSharpen() {
  clearTimeout(sharpenTimer);
  sharpenTimer = window.setTimeout(() => {
    const host = $("#pages");
    const hr = host.getBoundingClientRect();
    for (const el of host.querySelectorAll<HTMLElement>(".page")) {
      const r = el.getBoundingClientRect();
      if (r.bottom > hr.top - 600 && r.top < hr.bottom + 600) void paintPage(Number(el.dataset.page));
    }
  }, 140);
}

function updateZoomControl() {
  const sel = document.getElementById("zoom") as HTMLSelectElement | null;
  if (!sel) return;
  const custom = sel.querySelector<HTMLOptionElement>('option[value="custom"]')!;
  custom.textContent = `${Math.round(state.zoom * 100)}%`;
  const step = ZOOM_STEPS.find((s) => Math.abs(s - state.zoom) < 0.005);
  sel.value = state.zoomMode !== "custom" ? state.zoomMode : step !== undefined ? String(step) : "custom";
  // The fit options show the resulting percentage too.
  for (const m of ["fit-width", "fit-page"] as const) {
    const o = sel.querySelector<HTMLOptionElement>(`option[value="${m}"]`)!;
    const label = m === "fit-width" ? "Fit width" : "Fit page";
    o.textContent = state.zoomMode === m ? `${label} (${Math.round(state.zoom * 100)}%)` : label;
  }
}

function goToPage(i: number, smooth = false) {
  const pages = currentPages();
  if (!pages.length) return;
  i = Math.max(0, Math.min(pages.length - 1, i));
  const el = document.querySelector<HTMLElement>(`#pages .page[data-page="${pages[i].index}"]`);
  if (!el) return;
  const host = $("#pages");
  const top = el.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop - 12;
  host.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
  setCurrentPage(i);
}

function setCurrentPage(i: number) {
  if (i === state.currentPage && document.getElementById("page-num")?.dataset.page === String(i)) return;
  state.currentPage = i;
  const input = document.getElementById("page-num") as HTMLInputElement | null;
  if (input && document.activeElement !== input) {
    input.value = String(i + 1);
    input.dataset.page = String(i);
  }
  for (const t of document.querySelectorAll<HTMLElement>("#thumbs .thumb")) {
    const on = Number(t.dataset.pos) === i;
    t.classList.toggle("current", on);
    if (on) t.scrollIntoView({ block: "nearest" });
  }
}

/** Which page is "current": the one covering a line a third of the way down the view. */
function trackCurrentPage() {
  const host = $("#pages");
  const hr = host.getBoundingClientRect();
  const line = hr.top + Math.min(host.clientHeight / 3, 240);
  const els = [...host.querySelectorAll<HTMLElement>(".page")];
  let pos = 0;
  for (let k = 0; k < els.length; k++) {
    if (els[k].getBoundingClientRect().top <= line) pos = k;
    else break;
  }
  setCurrentPage(pos);
}

/* Thumbnails --------------------------------------------------------- */

const THUMB_W = 84;
let thumbObserver: IntersectionObserver | null = null;
const thumbRendered = new Map<number, string>();
const thumbToken = new Map<number, number>();

function setThumbs(on: boolean) {
  state.thumbs = on;
  savePref("thumbs", on);
  document.body.dataset.thumbs = String(on);
  buildThumbs();
  renderToolbar();
  if (state.zoomMode !== "custom") zoomFit(state.zoomMode);
}

function buildThumbs() {
  const rail = document.getElementById("thumbs");
  if (!rail) return;
  rail.replaceChildren();
  thumbObserver?.disconnect();
  thumbRendered.clear();
  if (!state.thumbs) return;
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) void paintThumb(Number((e.target as HTMLElement).dataset.page));
    },
    { root: rail, rootMargin: "400px 0px" },
  );
  currentPages().forEach((p, pos) => {
    const marks = state.view === "original" ? state.marks.filter((m) => m.page === p.index).length : 0;
    const deleted = state.view === "original" && state.deleted.has(p.index);
    const t = h(
      "button",
      {
        class: "thumb" + (pos === state.currentPage ? " current" : "") + (deleted ? " deleted" : ""),
        "data-page": String(p.index),
        "data-pos": String(pos),
        title: `Page ${p.index + 1}${marks ? ` · ${marks} redaction${marks > 1 ? "s" : ""}` : ""}${deleted ? " · will be deleted" : ""}`,
        onclick: () => goToPage(pos, true),
      },
      h("canvas", { style: { width: `${THUMB_W}px`, height: `${(p.height / p.width) * THUMB_W}px` } }),
      h("span", { class: "thumb-num" }, String(p.index + 1)),
      marks > 0 && h("span", { class: "thumb-count" }, String(marks)),
    );
    rail.append(t);
    thumbObserver!.observe(t);
  });
}

async function paintThumb(index: number) {
  const p = currentPages().find((x) => x.index === index);
  if (!p) return;
  const scale = (THUMB_W / p.width) * (window.devicePixelRatio || 1);
  const sig = pageSignature(index);
  if (thumbRendered.get(index) === sig) return;
  thumbRendered.set(index, sig);
  const token = ++tokenSeq;
  thumbToken.set(index, token);
  try {
    const img = await fetchImage(index, scale, state.view, sig);
    if (thumbToken.get(index) !== token) return;
    const c = document.querySelector<HTMLCanvasElement>(`#thumbs .thumb[data-page="${index}"] canvas`);
    if (!c) return;
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d")!.putImageData(new ImageData(img.pixels as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  } catch (e) {
    thumbRendered.delete(index);
    console.error(e);
  }
}

/** Refresh thumbnail badges and images after marks or options change. */
function repaintThumbs() {
  if (!state.thumbs) return;
  for (const t of document.querySelectorAll<HTMLElement>("#thumbs .thumb")) {
    const index = Number(t.dataset.page);
    const n = state.view === "original" ? state.marks.filter((m) => m.page === index).length : 0;
    let badge = t.querySelector(".thumb-count");
    if (n && !badge) t.append((badge = h("span", { class: "thumb-count" })));
    if (badge) {
      if (n) badge.textContent = String(n);
      else badge.remove();
    }
    t.classList.toggle("deleted", state.view === "original" && state.deleted.has(index));
    if (thumbRendered.has(index)) void paintThumb(index);
  }
}

/* Pointer, wheel, touch and keyboard navigation ---------------------- */

let cancelDraw = () => {};
let spaceHeld = false;

function setupNavigation() {
  const host = $("#pages");

  // Ctrl/Cmd + wheel, and trackpad pinch (sent as ctrl + wheel), zoom at the cursor.
  host.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0025;
      zoomTo(state.zoom * Math.exp(-e.deltaY * unit), { x: e.clientX, y: e.clientY });
    },
    { passive: false },
  );

  // Safari trackpad pinch.
  let gestureStart = 1;
  host.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    gestureStart = state.zoom;
  });
  host.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    const g = e as unknown as { scale: number; clientX: number; clientY: number };
    zoomTo(gestureStart * g.scale, { x: g.clientX, y: g.clientY });
  });

  // Two-finger pinch on touch screens.
  let pinch: { d0: number; z0: number } | null = null;
  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  host.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        cancelDraw();
        pinch = { d0: dist(e.touches), z0: state.zoom };
        e.preventDefault();
      }
    },
    { passive: false },
  );
  host.addEventListener(
    "touchmove",
    (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      zoomTo((pinch.z0 * dist(e.touches)) / pinch.d0, mid(e.touches));
    },
    { passive: false },
  );
  host.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) pinch = null;
  });

  // Panning with the mouse: middle button, Space + drag, or (in Pick mode)
  // dragging on empty space. Runs in the capture phase, before drawing/picking.
  let pan: { pid: number; x: number; y: number; sl: number; st: number; moved: boolean; clickTarget: HTMLElement | null } | null = null;
  host.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "touch") return; // fingers scroll natively
      const target = e.target as HTMLElement;
      const onEmpty = !target.closest(".obj, .mark, button, input, select");
      const pickPan = state.mode === "pick" && e.button === 0 && onEmpty && !e.shiftKey && !e.ctrlKey && !e.metaKey;
      const viewPan = state.view === "result" && e.button === 0;
      if (!(e.button === 1 || (spaceHeld && e.button === 0) || pickPan || viewPan)) return;
      pan = { pid: e.pointerId, x: e.clientX, y: e.clientY, sl: host.scrollLeft, st: host.scrollTop, moved: false, clickTarget: pickPan ? target : null };
      host.setPointerCapture(e.pointerId);
      if (!pickPan) document.body.classList.add("panning");
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  host.addEventListener("pointermove", (e) => {
    if (!pan || e.pointerId !== pan.pid) return;
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (!pan.moved && Math.hypot(dx, dy) < 4) return;
    pan.moved = true;
    document.body.classList.add("panning");
    host.scrollLeft = pan.sl - dx;
    host.scrollTop = pan.st - dy;
  });
  const endPan = (e: PointerEvent) => {
    if (!pan || e.pointerId !== pan.pid) return;
    // A click (no drag) on empty space in Pick mode clears the selection.
    if (!pan.moved && pan.clickTarget?.closest(".overlay")) clearSelection();
    pan = null;
    document.body.classList.remove("panning");
  };
  host.addEventListener("pointerup", endPan);
  host.addEventListener("pointercancel", endPan);

  let raf = 0;
  host.addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      trackCurrentPage();
    });
  });

  window.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      spaceHeld = false;
      document.body.classList.remove("space-pan");
    }
  });
  window.addEventListener("blur", () => {
    spaceHeld = false;
    document.body.classList.remove("space-pan");
  });
}

/** Keyboard shortcuts for zoom and paging. Returns true when handled. */
function navKey(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const host = $("#pages");
  const hScroll = host.scrollWidth > host.clientWidth + 1;
  if (mod && (e.key === "=" || e.key === "+")) zoomStep(1);
  else if (mod && e.key === "-") zoomStep(-1);
  else if (mod && e.key === "0") zoomFit("fit-width");
  else if (mod) return false;
  else if (e.key === "PageDown" || (e.key === "ArrowRight" && !hScroll)) goToPage(state.currentPage + 1);
  else if (e.key === "PageUp" || (e.key === "ArrowLeft" && !hScroll)) goToPage(state.currentPage - 1);
  else if (e.key === "Home") goToPage(0);
  else if (e.key === "End") goToPage(currentPages().length - 1);
  else if (e.key === " ") {
    spaceHeld = true;
    document.body.classList.add("space-pan");
  } else return false;
  e.preventDefault();
  return true;
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
  const page = state.currentPage;
  if (state.zoomMode !== "custom") state.zoom = fitZoom(state.zoomMode);
  renderToolbar();
  buildPages();
  goToPage(Math.min(page, currentPages().length - 1));
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
  repaintThumbs();
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

  cancelDraw = () => {
    drag?.box.remove();
    drag = null;
  };
  host.addEventListener("pointerdown", (e) => {
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
      { class: "seg thumbs-toggle" },
      h("button", { title: state.thumbs ? "Hide page thumbnails" : "Show page thumbnails", class: state.thumbs ? "on" : "", onclick: () => setThumbs(!state.thumbs) }, "▤"),
    ),
    h(
      "div",
      { class: "seg pagenav", role: "group", "aria-label": "Pages" },
      h("button", { title: "Previous page (PageUp)", onclick: () => goToPage(state.currentPage - 1) }, "‹"),
      h(
        "label",
        { class: "pagebox" },
        h("input", {
          id: "page-num",
          inputmode: "numeric",
          "aria-label": "Page number",
          value: String(state.currentPage + 1),
          onfocus: (e: Event) => (e.target as HTMLInputElement).select(),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === "Enter") {
              const n = parseInt((e.target as HTMLInputElement).value, 10);
              if (!Number.isNaN(n)) goToPage(n - 1);
              (e.target as HTMLInputElement).blur();
              $("#pages").focus({ preventScroll: true });
            } else if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          },
          onblur: (e: Event) => ((e.target as HTMLInputElement).value = String(state.currentPage + 1)),
        }),
        h("span", { class: "muted" }, `/ ${currentPages().length}`),
      ),
      h("button", { title: "Next page (PageDown)", onclick: () => goToPage(state.currentPage + 1) }, "›"),
    ),
    h(
      "div",
      { class: "seg zoom" },
      h("button", { title: "Zoom out (Ctrl −)", onclick: () => zoomStep(-1) }, "−"),
      h(
        "select",
        {
          id: "zoom",
          "aria-label": "Zoom",
          title: "Zoom (Ctrl + wheel or pinch to zoom, Ctrl 0 to fit width)",
          onchange: (e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v === "fit-width" || v === "fit-page") zoomFit(v);
            else if (v !== "custom") zoomTo(Number(v));
            $("#pages").focus({ preventScroll: true });
          },
        },
        h("option", { value: "fit-width" }, "Fit width"),
        h("option", { value: "fit-page" }, "Fit page"),
        ...ZOOM_STEPS.map((z) => h("option", { value: String(z) }, `${Math.round(z * 100)}%`)),
        h("option", { value: "custom", hidden: true }, ""),
      ),
      h("button", { title: "Zoom in (Ctrl +)", onclick: () => zoomStep(1) }, "+"),
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
    h("button", { class: "btn primary export", onclick: doExport, disabled: state.busy }, state.result ? "Export again" : "Apply & export"),
  ));
  updateZoomControl();
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
      h("a", { class: "brand", href: "./" }, icon(LOGO, "logo"), "PDF Scrub"),
      h("span", { id: "doc-name", class: "doc-name" }),
      h("span", { class: "grow" }),
      h("span", { class: "badge", title: "No server: your file is processed in this browser tab and is never uploaded." }, "🔒 Stays on your device"),
      h("button", { class: "btn small editor-only", onclick: pick, title: "Open another PDF" }, h("span", { class: "long" }, "Open another PDF"), h("span", { class: "short" }, "Open")),
      h(
        "a",
        { class: "author", href: SITE.authorUrl, rel: "noopener", target: "_blank", title: `${SITE.author} on GitHub` },
        h("span", { class: "author-by" }, "by "),
        h("span", { class: "author-name" }, SITE.author),
      ),
      h(
        "a",
        {
          class: "gh",
          href: SITE.repoUrl,
          rel: "noopener",
          target: "_blank",
          title: "Source code on GitHub" + (SITE.stars !== null ? ` · ${SITE.stars} stars · ${SITE.forks ?? 0} forks` : ""),
          "aria-label": "Source code on GitHub",
        },
        icon(ICONS.github, "gh-mark"),
        h("span", { class: "gh-label" }, "GitHub"),
        SITE.stars !== null && h("span", { class: "gh-stat" }, icon(ICONS.star), formatCount(SITE.stars)),
        SITE.forks !== null && h("span", { class: "gh-stat gh-forks" }, icon(ICONS.fork), formatCount(SITE.forks)),
      ),
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
      h("nav", { id: "thumbs", class: "thumbs", "aria-label": "Page thumbnails" }),
      h("div", { id: "pages", class: "pages", tabindex: "0", "aria-label": "Document pages" }),
      // On narrow screens the two panels share one scroll area under the pages.
      h(
        "div",
        { class: "side" },
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
      h(
        "aside",
        { class: "panel right" },
        h("h2", {}, "Redactions"),
        h("div", { id: "marks" }),
        h("h2", {}, "Clean-up"),
        h("div", { id: "cleanup", class: "cleanup" }),
      ),
      ),
    ),
    h(
      "footer",
      { class: "foot landing-only" },
      "Open source. Built on ",
      h("a", { href: "https://mupdf.com/", rel: "noopener" }, "MuPDF"),
      " (AGPL-3.0) compiled to WebAssembly. ",
      h("a", { href: SITE.repoUrl, rel: "noopener" }, "Source code"),
      ". Made by ",
      h("a", { href: SITE.authorUrl, rel: "noopener" }, SITE.author),
      ".",
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
    if (document.querySelector("dialog[open]")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (navKey(e)) return;
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
    rt = window.setTimeout(() => {
      if (!state.pages.length || document.body.dataset.screen !== "editor") return;
      if (state.zoomMode !== "custom") zoomFit(state.zoomMode);
    }, 150);
  });

  setupDrawing();
  setupNavigation();
}

/** Wrap a static, trusted SVG string (from site.ts) in a span. */
function icon(svgMarkup: string, cls = "") {
  const span = h("span", { class: "icon-svg" + (cls ? " " + cls : "") });
  span.innerHTML = svgMarkup;
  return span;
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
ready.catch((e) => toast(String(e.message ?? e)));
