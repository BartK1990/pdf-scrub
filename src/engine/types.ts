/** Rectangle in PDF page space as MuPDF reports it: [x0, y0, x1, y1], y grows downward. */
export type Rect = [number, number, number, number];

export type MarkSource = "area" | "search" | "object" | "hidden" | "preset";

/** One region to redact. Everything inside the rectangle is removed. */
export interface Mark {
  id: string;
  page: number;
  rect: Rect;
  source: MarkSource;
  label: string;
}

export interface PageInfo {
  index: number;
  width: number;
  height: number;
  x0: number;
  y0: number;
}

export interface PageObject {
  kind: "image" | "block" | "line";
  rect: Rect;
  label: string;
}

export interface SearchHit {
  page: number;
  rects: Rect[];
  text: string;
}

export interface HiddenTextHit extends SearchHit {
  reason: "white" | "tiny" | "off-page";
}

export interface DocReport {
  pageCount: number;
  metadata: Record<string, string>;
  hasXmpMetadata: boolean;
  hasJavaScript: boolean;
  attachments: string[];
  annotations: Record<string, number>;
  links: number;
  formFields: number;
  encrypted: boolean;
}

export interface ExportOptions {
  stripMetadata: boolean;
  removeAnnotations: boolean;
  removeLinks: boolean;
  removeAttachments: boolean;
  removeJavaScript: boolean;
  forms: "keep" | "flatten" | "remove";
  removeAllImages: boolean;
  removeAllVectors: boolean;
  blackBoxes: boolean;
  deletePages: number[];
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  stripMetadata: true,
  removeAnnotations: true,
  removeLinks: false,
  removeAttachments: true,
  removeJavaScript: true,
  forms: "flatten",
  removeAllImages: false,
  removeAllVectors: false,
  blackBoxes: true,
  deletePages: [],
};

export interface OpenResult {
  pages: PageInfo[];
  report: DocReport;
}

export interface ExportResult {
  bytes: Uint8Array;
  /** Extracted text of the result, one string per page. */
  text: string[];
  redactionsApplied: number;
  pagesRemoved: number;
  pageCount: number;
  report: DocReport;
}
