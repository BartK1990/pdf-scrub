import { defineConfig, type Plugin } from "vite";

/**
 * Content-Security-Policy for the production build. It enforces the
 * privacy promise in the browser: the page may not send data to any
 * other origin (connect-src 'self'), so a PDF cannot leave the device.
 */
const csp: Plugin = {
  name: "csp",
  apply: "build",
  transformIndexHtml(html) {
    const policy = [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "worker-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
    return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
  },
};

export default defineConfig({
  // Relative base: works at https://<user>.github.io/<repo>/ and on any other static host.
  base: "./",
  plugins: [csp],
  build: { target: "es2022", assetsInlineLimit: 0 },
  worker: { format: "es" },
  // MuPDF loads its .wasm via new URL(..., import.meta.url); pre-bundling would break that.
  optimizeDeps: { exclude: ["mupdf"] },
});
