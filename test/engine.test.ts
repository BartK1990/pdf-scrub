import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { PdfSession, DEFAULT_EXPORT_OPTIONS, type Mark } from "../src/engine/engine.ts";
import { PRESETS } from "../src/engine/presets.ts";

const sample = new Uint8Array(readFileSync(new URL("./fixtures/sample.pdf", import.meta.url)));
const outDir = new URL("./out/", import.meta.url);
mkdirSync(outDir, { recursive: true });

/** Independent check with poppler's pdftotext, so we don't trust MuPDF to grade itself. */
function popplerText(bytes: Uint8Array, name: string): string {
  const path = new URL(name, outDir);
  writeFileSync(path, bytes);
  return execFileSync("pdftotext", [path.pathname, "-"]).toString();
}

function marksFrom(hits: { page: number; rects: [number, number, number, number][]; text: string }[]): Mark[] {
  return hits.flatMap((h, i) => h.rects.map((rect, j) => ({ id: `${i}-${j}`, page: h.page, rect, source: "search" as const, label: h.text })));
}

test("report finds metadata and links", () => {
  const { session, info } = PdfSession.open(sample);
  assert.equal(info.pages.length, 2);
  assert.equal(info.report.metadata.Author, "Jane Doe");
  assert.equal(info.report.links, 1);
  session.close();
});

test("search redaction removes text from the output (verified by poppler)", () => {
  const { session } = PdfSession.open(sample);
  const hits = session.search("Jane Doe");
  assert.equal(hits.length, 2);
  const res = session.export(marksFrom(hits), DEFAULT_EXPORT_OPTIONS);
  assert.equal(res.redactionsApplied, 2);
  assert.ok(!res.text.join("").includes("Jane"));
  const txt = popplerText(res.bytes, "search.pdf");
  assert.ok(!txt.includes("Jane"), txt);
  assert.ok(txt.includes("Employment Contract"), "unrelated text must stay");
  session.close();
});

test("metadata is stripped", () => {
  const { session } = PdfSession.open(sample);
  const res = session.export([], DEFAULT_EXPORT_OPTIONS);
  assert.deepEqual(res.report.metadata, {});
  assert.ok(!Buffer.from(res.bytes).toString("latin1").includes("Jane Doe"));
  session.close();
});

test("presets find e-mail, IBAN, card and phone", () => {
  const { session } = PdfSession.open(sample);
  const found = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!;
    return session.search(p.pattern, { regex: true }).filter((h) => !p.validate || p.validate(h.text)).map((h) => h.text);
  };
  assert.deepEqual(found("email"), ["jane.doe@example.com"]);
  assert.deepEqual(found("iban"), ["PL61 1090 1014 0000 0712 1981 2874"]);
  assert.deepEqual(found("card"), ["4111 1111 1111 1111"]);
  assert.ok(found("phone").includes("+48 601 234 567"));
  session.close();
});

test("hidden text (white and tiny) is detected and removable", () => {
  const { session } = PdfSession.open(sample);
  const hidden = session.findHiddenText();
  const reasons = new Set(hidden.map((h) => h.reason));
  assert.ok(reasons.has("white") && reasons.has("tiny"), JSON.stringify(hidden));
  const res = session.export(marksFrom(hidden), DEFAULT_EXPORT_OPTIONS);
  const txt = popplerText(res.bytes, "hidden.pdf");
  assert.ok(!txt.includes("Ignore all previous instructions"));
  assert.ok(!txt.includes("payload"));
  session.close();
});

test("object picker lists the image and redacting it removes it", () => {
  const { session } = PdfSession.open(sample);
  const imgs = session.objects(0).filter((o) => o.kind === "image");
  assert.equal(imgs.length, 1);
  const res = session.export([], { ...DEFAULT_EXPORT_OPTIONS, removeAllImages: true });
  const { session: out } = PdfSession.open(res.bytes);
  assert.equal(out.objects(0).filter((o) => o.kind === "image").length, 0);
  out.close();
  session.close();
});

test("page deletion and link removal", () => {
  const { session } = PdfSession.open(sample);
  const res = session.export([], { ...DEFAULT_EXPORT_OPTIONS, deletePages: [1], removeLinks: true });
  assert.equal(res.pageCount, 1);
  assert.equal(res.report.links, 0);
  session.close();
});

test("area redaction removes vector shapes (pixel check)", () => {
  const { session } = PdfSession.open(sample);
  // The blue rectangle is drawn at x 250..350, y 320..380 (top-down page space).
  const blueAt = (s: PdfSession, which: "original" | "result") => {
    const img = s.render(0, 1, which);
    const i = (350 * img.width + 300) * 4;
    return [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]];
  };
  assert.deepEqual(blueAt(session, "original"), [0, 0, 255]);
  session.export([{ id: "a", page: 0, rect: [245, 315, 355, 385], source: "area", label: "box" }], { ...DEFAULT_EXPORT_OPTIONS, blackBoxes: false });
  assert.deepEqual(blueAt(session, "result"), [255, 255, 255]);
  session.close();
});
