# PDF Scrub

**Clean a PDF before you give it to AI.** PDF Scrub is a static web app, hosted on GitHub Pages, that removes sensitive content from PDF files in your browser. You get a clean copy that is safe to pass to ChatGPT, Claude, Gemini or any other LLM.

Your file is never uploaded. All processing happens in your browser tab.

## What it does

| | |
|---|---|
| **Real redaction** | Removes the text, image pixels and vector drawings under each marked area from the file itself. Drawing a black box over text, as many editors do, leaves the text in the file for an LLM to read. |
| **Three ways to mark content** | Drag a rectangle over an area; click on text lines, paragraphs or images ("Pick objects"); or search (plain text, whole word, regex). |
| **Detectors** | E-mails, phone numbers, IBANs (checksum-validated), payment cards (Luhn-validated), IP addresses, URLs, dates. |
| **Hidden-text scan** | Finds white, microscopic and off-page text. People can't see it but LLMs read it, which makes it a common way to hide prompt-injection text. |
| **Document clean-up** | Strips metadata (Info dictionary and XMP), JavaScript and auto-run actions, embedded files, comments/annotations, links; flattens or removes form fields; can remove all images or all vector graphics; deletes whole pages. |
| **Verification** | After export, shows the exact text an LLM would extract from the new file and checks that none of the redacted text is left. The text can be copied or downloaded as `.txt`. |

## Architecture

```
┌──────────────────────── Browser tab (GitHub Pages, static files only) ─────────────────────────┐
│                                                                                               │
│  UI thread (src/main.ts, plain TypeScript)          Web Worker (src/worker.ts)                │
│  ┌───────────────────────────────────┐   RPC      ┌──────────────────────────────────────┐    │
│  │ pages: <canvas> + overlay         │ ─────────▶ │ PdfSession (src/engine/engine.ts)    │    │
│  │ marks[] (rects in PDF space)      │ postMessage│  • render page → RGBA pixels         │    │
│  │ undo/redo, search hits, options   │ ◀───────── │  • structured text → objects, search │    │
│  │ result dialog, text preview       │ transfer   │  • export: redact + sanitize + save  │    │
│  └───────────────────────────────────┘            │           MuPDF (WebAssembly)        │    │
│                                                   └──────────────────────────────────────┘    │
│  Content-Security-Policy: connect-src 'self' → the page cannot send data to any other origin  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

Design decisions:

- **No backend.** Static files only, so GitHub Pages is enough, hosting costs nothing, and documents cannot leak through a server. The production build adds a strict Content-Security-Policy, so the browser itself blocks requests to other origins.
- **MuPDF compiled to WebAssembly** ([`mupdf` on npm](https://www.npmjs.com/package/mupdf)) is the single engine for rendering, text extraction, redaction and saving. Its `applyRedactions` rewrites the page content streams, and it's fast, mature C code. Alternatives considered:
  - *pdf.js + pdf-lib:* good viewer and writer, but no content removal, so "redaction" would only be a cosmetic overlay.
  - *Rasterize every page:* safe, but the text is gone, which defeats the purpose when the file is for an LLM.
- **Heavy work runs in a Web Worker**, so the UI never freezes on large files. Pixel buffers are transferred, not copied.
- **Non-destructive editing.** Marks are just rectangles in PDF coordinates held in the UI, so undo/redo is cheap. On export the worker reopens the *original* bytes and applies every mark in one pass. The order matters: flatten forms → remove annotations/links/JS/attachments/metadata → redact → whole-page passes (all images / all vectors) → delete pages → save with `garbage,clean,sanitize`.
- **Framework-free UI.** About 9 KB gzipped. Nearly all of the download is the WASM engine (about 4.8 MB gzipped), which the browser caches after the first visit.
- **The engine is DOM-free**, so the same `engine.ts` runs in Node for tests. The tests check results with poppler's `pdftotext`, a separate PDF library, rather than trusting MuPDF to grade its own output.

```
src/
  engine/engine.ts    PDF logic (MuPDF): render, objects, search, hidden text, report, export
  engine/presets.ts   PII detectors (regex + checksum validators)
  engine/types.ts     shared types and default export options
  worker.ts           Web Worker hosting the engine
  api.ts              typed RPC client for the worker
  main.ts             UI
  style.css           styles (light + dark)
test/
  engine.test.ts      Node tests (node:test), verified with pdftotext
  make-fixture.py     generates test/fixtures/sample.pdf (reportlab)
.github/workflows/deploy.yml   test → build → deploy to GitHub Pages
```

## Development

Requires Node 22+ (the tests run TypeScript directly) and `pdftotext` (poppler-utils) for the tests.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine tests
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/ locally
```

## Deploying

1. Push to `main` on GitHub.
2. In the repository go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. The workflow tests, builds and publishes to `https://<user>.github.io/<repo>/`. The build uses relative paths, so any repository name works.

## Limits

- Scanned PDFs (pages that are images) have no text to search. Use *Draw area* or *Pick objects → image*. OCR is a possible future addition.
- Text drawn with invisible render mode (common in OCR layers) is not flagged by the hidden-text scan yet; white, tiny and off-page text are.
- Detectors are suggestions. Always review the text preview before sharing the file.

## License

[AGPL-3.0-or-later](LICENSE), because the app uses MuPDF, which is AGPL-licensed. The source of the deployed site is this repository, which meets the AGPL's requirement to offer the source to users.
