# LEAF

LEAF is a mobile first, local only ebook reader concept. It has no backend, accounts, or document uploads.

## Run locally

Serve this folder over HTTP (for example, use the VS Code Live Server extension or `python -m http.server`) and open the local address. PDF.js 6.3.289 is loaded on demand from a version pinned jsDelivr CDN URL; the PDF.js worker performs document parsing and the selected PDF bytes are passed directly to PDF.js in the browser. The PDF file itself is never sent to the CDN. An internet connection is needed the first time PDF.js is opened. This app currently does not include an offline service worker or a bundled PDF.js distribution.

## Publish on GitHub Pages

The repository includes `.github/workflows/deploy.yml`. Create a GitHub repository with the `main` branch, upload these project files, then set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. Each push to `main` deploys the static app; the published URL appears in the workflow's `github-pages` deployment environment.

## PDF reader

The primary mode extracts text from every PDF page in batches and presents the reconstructed paragraphs in a responsive HTML reading column. The reading view includes font family, size, line spacing, width, and theme controls; preferences and reading position are saved to IndexedDB when available, with localStorage as a fallback. Original PDF mode builds a navigable page list and renders canvases only near the viewport.

Paragraph reconstruction uses text-item positions, baseline gaps, font size, and simple list and heading heuristics. Complex layouts, tables, right-to-left text, and scanned image PDFs may need OCR or manual correction. A scanned PDF is detected when it contains no extractable text; the original PDF view remains available.

## EPUB

The existing file picker recognizes EPUB files, but EPUB chapter rendering is not implemented yet.
