# LEAF

LEAF is a mobile first, local only ebook reader concept. It has no backend or account system.

## Current phase: reader shell and local import

This first phase establishes the responsive reader landing screen, local PDF file selection with the browser's native PDF viewer as a fallback, and the app's privacy first visual direction. EPUB selection is recognized, but EPUB rendering is intentionally left for a later phase.

## Run locally

Open `index.html` in a modern browser. PDF display depends on the browser's built in PDF support. This phase does not require a build step or send selected files over the network.

## Suggested next phase

Add PDF.js text extraction, scanned PDF detection, and responsive reflow, while keeping the original PDF available as a fallback. EPUB.js chapter rendering can follow as a separate phase.
