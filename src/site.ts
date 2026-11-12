/**
 * Site identity and repository stats.
 *
 * Star and fork counts are fetched at BUILD time by the GitHub Actions
 * workflow and baked into the page. The browser never calls the GitHub
 * API, so the strict "no requests to other origins" policy still holds.
 */
const env = import.meta.env;

export const SITE = {
  author: "Bartosz Kuriata",
  authorUrl: "https://github.com/BartK1990",
  repoUrl: (env.VITE_REPO_URL as string | undefined) || "https://github.com/BartK1990/pdf-scrub",
  stars: toCount(env.VITE_REPO_STARS),
  forks: toCount(env.VITE_REPO_FORKS),
};

function toCount(v: unknown): number | null {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : null;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/* Inline SVG icons (GitHub Octicons, MIT). Static strings, safe for innerHTML. */
const svg = (path: string, title = "") =>
  `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"${title ? ` aria-label="${title}"` : ""}><path fill="currentColor" d="${path}"/></svg>`;

export const ICONS = {
  github: svg(
    "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z",
  ),
  star: svg(
    "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z",
  ),
  fork: svg(
    "M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z",
  ),
};

/** App logo: a page whose middle line is redacted. */
export const LOGO = `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false">
  <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4c6ef5"/><stop offset="1" stop-color="#3b5bdb"/></linearGradient></defs>
  <rect width="32" height="32" rx="8" fill="url(#lg)"/>
  <path d="M9 6.5h10l5 5V25a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 8 25V8a1.5 1.5 0 0 1 1-1.5Z" fill="#fff"/>
  <path d="M19 6.5v4.2c0 .4.3.8.8.8H24" fill="#dbe4ff"/>
  <rect x="11" y="13.5" width="10" height="2" rx="1" fill="#adb5bd"/>
  <rect x="11" y="17.5" width="8" height="3" rx=".6" fill="#16181d"/>
  <rect x="11" y="22" width="7" height="2" rx="1" fill="#adb5bd"/>
</svg>`;
