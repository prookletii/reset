const PDFJS_VERSION = '6.3.289';
const PDFJS_MODULE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

const $ = (selector) => document.querySelector(selector);
const input = $('#document-input');
const dialog = $('#reader-dialog');
const scrollArea = $('#reader-scroll');
const ebook = $('#ebook');
const originalPages = $('#original-pages');
const loadingState = $('#loading-state');
const loadingDetail = $('#loading-detail');
const status = $('#reader-status');
const errorBox = $('#reader-error');
const settingsPanel = $('#settings-panel');
const positionLabel = $('#position-label');
const bottomPosition = $('#bottom-position');
const progressFill = $('#progress-fill');
const chapterSetting = $('#chapter-setting');
const originalControls = $('#original-controls');
const modeToggle = $('#mode-toggle');

let pdfjsPromise;
let stateDbPromise;
let loadGeneration = 0;
let activeLoadingTask = null;
let pdfDocument = null;
let documentModel = null;
let documentKey = null;
let originalMode = false;
let pageObserver = null;
let progressTimer = 0;
let resizeTimer = 0;
let currentZoom = 1;
let pageRenderQueue = Promise.resolve();
const pageRenderTasks = new Map();
const activePageElements = new Set();

function getPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_MODULE).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return lib;
    });
  }
  return pdfjsPromise;
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fnv1a(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function identityFor(file) {
  return `leaf-reading-position:${fnv1a(`${file.name}|${file.size}|${file.lastModified}`)}`;
}

function openStateDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (!stateDbPromise) {
    stateDbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open('leaf-reader-state', 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return stateDbPromise;
}

async function readState(key, fallbackKey = key) {
  const db = await openStateDb();
  if (db) {
    const value = await new Promise((resolve) => {
      try {
        const request = db.transaction('state', 'readonly').objectStore('state').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
    if (value !== undefined) return value;
  }
  try { return JSON.parse(localStorage.getItem(fallbackKey) || 'null'); } catch { return null; }
}

async function writeState(key, value, fallbackKey = key) {
  const db = await openStateDb();
  if (db) {
    const stored = await new Promise((resolve) => {
      try {
        const transaction = db.transaction('state', 'readwrite');
        transaction.objectStore('state').put(value, key);
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => resolve(false);
        transaction.onabort = () => resolve(false);
      } catch { resolve(false); }
    });
    if (stored) return;
  }
  try { localStorage.setItem(fallbackKey, JSON.stringify(value)); } catch { /* Private browsing can disable persistent storage. */ }
}

async function applyPreferences() {
  const preferences = (await readState('preferences', 'leaf-reader-preferences')) || {};
  const font = $('#font-setting');
  const size = $('#font-size-setting');
  const leading = $('#line-height-setting');
  const width = $('#width-setting');
  const theme = $('#theme-setting');
  const literata = font.querySelector('[value^="Literata"]');
  if (literata && !document.fonts.check('16px Literata')) literata.hidden = true;
  font.value = preferences.font || font.value;
  size.value = String(preferences.size || size.value);
  leading.value = String(preferences.leading || leading.value);
  width.value = preferences.width || width.value;
  theme.value = preferences.theme || theme.value;
  updateReaderStyles(false);
}

function savePreferences() {
  const preferences = {
    font: $('#font-setting').value,
    size: Number($('#font-size-setting').value),
    leading: Number($('#line-height-setting').value),
    width: $('#width-setting').value,
    theme: $('#theme-setting').value,
  };
  void writeState('preferences', preferences, 'leaf-reader-preferences');
}

function captureAnchor() {
  const items = [...scrollArea.querySelectorAll('.reader-anchor')];
  if (!items.length) return null;
  const top = scrollArea.getBoundingClientRect().top + 90;
  const anchor = items.find((item) => item.getBoundingClientRect().bottom > top) || items.at(-1);
  return { id: anchor.id, offset: anchor.getBoundingClientRect().top - top };
}

function restoreAnchor(anchor) {
  if (!anchor?.id) return;
  const element = document.getElementById(anchor.id);
  if (!element) return;
  const current = element.getBoundingClientRect().top;
  const target = scrollArea.getBoundingClientRect().top + 90 + (anchor.offset || 0);
  const previousBehavior = scrollArea.style.scrollBehavior;
  scrollArea.style.scrollBehavior = 'auto';
  scrollArea.scrollTop += current - target;
  scrollArea.style.scrollBehavior = previousBehavior;
}

function updateReaderStyles(keepPosition = true) {
  const anchor = keepPosition ? captureAnchor() : null;
  ebook.style.setProperty('--book-font', $('#font-setting').value);
  ebook.style.setProperty('--book-size', `${$('#font-size-setting').value}px`);
  ebook.style.setProperty('--book-leading', $('#line-height-setting').value);
  ebook.dataset.width = $('#width-setting').value;
  dialog.dataset.theme = $('#theme-setting').value;
  $('#font-size-value').textContent = `${$('#font-size-setting').value}px`;
  $('#line-height-value').textContent = Number($('#line-height-setting').value).toFixed(2).replace(/0$/, '');
  if (anchor) requestAnimationFrame(() => restoreAnchor(anchor));
}

async function persistPosition() {
  if (!documentKey || !documentModel) return;
  const anchor = captureAnchor();
  const key = documentKey;
  const state = {
    page: currentSourcePage(),
    paragraphId: anchor?.id || null,
    offset: anchor?.offset || 0,
    ratio: scrollArea.scrollHeight > scrollArea.clientHeight
      ? scrollArea.scrollTop / (scrollArea.scrollHeight - scrollArea.clientHeight)
      : 0,
  };
  await writeState(key, state);
}

function schedulePersist() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    updateProgress();
    persistPosition();
  }, 180);
}

function currentSourcePage() {
  const maxScroll = Math.max(1, scrollArea.scrollHeight - scrollArea.clientHeight);
  if (scrollArea.scrollTop / maxScroll >= .995) return documentModel?.totalPages || 1;
  if (originalMode) {
    const pages = [...originalPages.querySelectorAll('.pdf-page')];
    const threshold = scrollArea.getBoundingClientRect().top + 28;
    const active = pages.filter((page) => page.getBoundingClientRect().top <= threshold).at(-1) || pages[0];
    return Number(active?.dataset.page || 1);
  }
  const sections = [...ebook.querySelectorAll('section[data-page]')];
  const threshold = scrollArea.getBoundingClientRect().top + 28;
  const section = sections.filter((node) => node.getBoundingClientRect().top <= threshold).at(-1) || sections[0];
  return Number(section?.dataset.page || 1);
}

function updateProgress() {
  if (!documentModel || !dialog.open) return;
  const max = Math.max(1, scrollArea.scrollHeight - scrollArea.clientHeight);
  const ratio = Math.max(0, Math.min(1, scrollArea.scrollTop / max));
  progressFill.style.width = `${ratio * 100}%`;
  const page = currentSourcePage();
  const label = `${page} / ${documentModel.totalPages}`;
  positionLabel.textContent = label;
  bottomPosition.textContent = `${Math.round(ratio * 100)}% · p. ${page}`;
}

function restorePosition(fileKey, saved) {
  if (!saved) return null;
  const element = saved.paragraphId && document.getElementById(saved.paragraphId);
  requestAnimationFrame(() => {
    const previousBehavior = scrollArea.style.scrollBehavior;
    scrollArea.style.scrollBehavior = 'auto';
    if (Number.isFinite(saved.ratio)) {
      const max = Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight);
      scrollArea.scrollTop = max * Math.max(0, Math.min(1, saved.ratio));
    }
    if (element?.isConnected) restoreAnchor({ id: element.id, offset: saved.offset || 0 });
    else if (saved.page) scrollArea.querySelector(`[data-page="${saved.page}"]`)?.scrollIntoView({ block: 'start' });
    scrollArea.style.scrollBehavior = previousBehavior;
    updateProgress();
  });
  return saved;
}

function groupIntoLines(items, styles) {
  const positioned = items.filter((item) => item.str && item.str.trim()).map((item, index) => {
    const transform = item.transform || [0, 0, 0, 0, 0, 0];
    const fontSize = Math.max(4, Math.abs(transform[3]) || item.height || 10);
    const style = styles[item.fontName] || {};
    return { text: item.str, x: transform[4] || 0, y: transform[5] || 0, width: Math.abs(item.width || 0), fontSize, fontName: item.fontName || '', bold: /bold|black|demi|heavy/i.test(`${item.fontName || ''} ${style.fontFamily || ''}`), index };
  });
  positioned.sort((a, b) => b.y - a.y || a.x - b.x || a.index - b.index);
  const lines = [];
  for (const item of positioned) {
    let line = lines.at(-1);
    if (!line || Math.abs(line.y - item.y) > Math.max(1.5, item.fontSize * .28)) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }
  return lines.map((line) => {
    const lineItems = line.items.sort((a, b) => a.x - b.x);
    let text = '';
    let last = null;
    for (const item of lineItems) {
      const part = item.text.replace(/\s+$/u, '');
      if (!part) continue;
      if (!text) text = part.trimStart();
      else {
        const priorEndsSpace = /\s$/u.test(text);
        const gap = item.x - (last.x + last.width);
        const visuallySeparated = gap > Math.max(1, Math.min(last.fontSize, item.fontSize) * .16);
        const needsSpace = priorEndsSpace || visuallySeparated;
        const nextStartsPunctuation = /^[,.;:!?%)\]}’']/u.test(part);
        const previousEndsOpen = /[(\[{‘“]$/u.test(text);
        if (/[-\u00ad]$/u.test(text) && /^[a-z]/u.test(part)) text = text.slice(0, -1) + part;
        else text += (!needsSpace || nextStartsPunctuation || previousEndsOpen ? '' : ' ') + part;
      }
      last = item;
    }
    const sizes = lineItems.map((item) => item.fontSize).sort((a, b) => a - b);
    return { text: text.trim(), y: line.y, fontSize: sizes[Math.floor(sizes.length / 2)] || 10, bold: lineItems.some((item) => item.bold), x: lineItems[0]?.x || 0 };
  }).filter((line) => line.text);
}

function reconstructParagraphs(lines, pageNumber, baselineFontSize) {
  const paragraphs = [];
  let current = null;
  let priorLine = null;
  const finish = () => {
    if (!current?.text.trim()) return;
    const text = current.text.replace(/\s+/gu, ' ').trim();
    const isShortUppercase = text.length > 3 && text.length < 100 && text === text.toLocaleUpperCase();
      const isHeading = (current.fontSize >= baselineFontSize * 1.2 && text.length < 180) || (current.bold && text.length < 150 && !/[.!?]$/u.test(text)) || (isShortUppercase && !/[.!?]$/u.test(text));
    const isBullet = /^(?:[•◦▪‣⁃*–—-]|\d{1,3}[.)]|[a-z][.)])\s+/u.test(text);
    const isQuote = /^[“"‘]/u.test(text);
    paragraphs.push({
      id: `p-${pageNumber}-${paragraphs.length + 1}`,
      text,
      sourcePage: pageNumber,
      type: isHeading ? (current.fontSize >= baselineFontSize * 1.55 ? 'h2' : 'h3') : isBullet ? 'li' : isQuote ? 'blockquote' : 'p',
    });
    current = null;
  };
  for (const line of lines) {
    if (!current) current = { text: line.text, fontSize: line.fontSize };
    else {
      const lineGap = priorLine ? Math.abs(priorLine.y - line.y) : 0;
      const largeGap = lineGap > Math.max(baselineFontSize * 2, priorLine?.fontSize * 2 || 0);
      const changedScale = Math.abs(line.fontSize - current.fontSize) > baselineFontSize * .35;
      const changedIndent = Math.abs(line.x - (priorLine?.x || line.x)) > baselineFontSize * 2.2;
      const boldTitleLine = line.bold && line.text.length < 150 && current.text.length < 180;
      if (largeGap || changedScale || changedIndent || boldTitleLine) finish();
      if (!current) current = { text: line.text, fontSize: line.fontSize, bold: line.bold };
      else {
        const dehyphenate = /[-\u00ad]$/u.test(current.text) && /^[a-z]/u.test(line.text);
        current.text += dehyphenate ? line.text : ` ${line.text}`;
        current.fontSize = Math.max(current.fontSize, line.fontSize);
        current.bold = current.bold || line.bold;
      }
    }
    priorLine = line;
  }
  finish();
  return paragraphs;
}

async function extractPdf(pdf) {
  const model = {
    id: `pdf-${fnv1a(`${pdf.fingerprints?.[0] || ''}|${pdf.numPages}`)}`,
    title: '',
    totalPages: pdf.numPages,
    paragraphs: [],
    processingStatus: 'processing',
  };
  const batchSize = 4;
  for (let start = 1; start <= pdf.numPages; start += batchSize) {
    const end = Math.min(pdf.numPages, start + batchSize - 1);
    loadingDetail.textContent = `Extracting pages ${start}–${end} of ${pdf.numPages}`;
    const pageResults = await Promise.all(Array.from({ length: end - start + 1 }, async (_, offset) => {
      const pageNumber = start + offset;
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const lines = groupIntoLines(content.items, content.styles || {});
      const sizes = lines.map((line) => line.fontSize).sort((a, b) => a - b);
      const median = sizes[Math.floor(sizes.length / 2)] || 10;
      const paragraphs = reconstructParagraphs(lines, pageNumber, median);
      page.cleanup();
      return paragraphs;
    }));
    model.paragraphs.push(...pageResults.flat());
    updateLoadingProgress(end, pdf.numPages);
    await yieldToBrowser();
  }
  model.processingStatus = model.paragraphs.length ? 'ready' : 'scanned';
  return model;
}

function updateLoadingProgress(page, total) {
  $('#loading-state p').textContent = `Preparing your book · ${Math.round(page / total * 100)}%`;
}

function appendParagraph(parent, paragraph) {
  let element;
  if (paragraph.type === 'li') {
    let list = parent.lastElementChild;
    if (!list || !['UL', 'OL'].includes(list.tagName)) {
      const ordered = /^\d/u.test(paragraph.text);
      list = document.createElement(ordered ? 'ol' : 'ul');
      parent.append(list);
    }
    element = document.createElement('li');
    element.textContent = paragraph.text.replace(/^(?:[•◦▪‣⁃*–—-]|\d{1,3}[.)]|[a-z][.)])\s+/u, '');
    list.append(element);
  } else {
    const tag = ['h2', 'h3', 'blockquote'].includes(paragraph.type) ? paragraph.type : 'p';
    element = document.createElement(tag);
    element.textContent = paragraph.text;
    parent.append(element);
  }
  element.classList.add('reader-anchor');
  element.id = paragraph.id;
  element.dataset.page = String(paragraph.sourcePage);
  element.dataset.paragraph = paragraph.id;
}

async function renderReflow(model) {
  ebook.replaceChildren();
  const byPage = new Map();
  for (const paragraph of model.paragraphs) {
    if (!byPage.has(paragraph.sourcePage)) byPage.set(paragraph.sourcePage, []);
    byPage.get(paragraph.sourcePage).push(paragraph);
  }
  const pages = [...byPage];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const [pageNumber, paragraphs] = pages[pageIndex];
    const section = document.createElement('section');
    section.dataset.page = String(pageNumber);
    section.setAttribute('aria-label', `Text from PDF page ${pageNumber}`);
    section.id = `page-${pageNumber}`;
    if (pageNumber !== byPage.keys().next().value) {
      const marker = document.createElement('div');
      marker.className = 'page-break';
      marker.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = `PDF page ${pageNumber}`;
      marker.append(label);
      section.append(marker);
    }
    for (const paragraph of paragraphs) appendParagraph(section, paragraph);
    ebook.append(section);
    if (pageIndex % 12 === 11) await yieldToBrowser();
  }
  ebook.hidden = false;
  loadingState.hidden = true;
  $('#loading-state p').textContent = 'Preparing your book…';
  fillContents(model);
}

function fillContents(model) {
  chapterSetting.replaceChildren(new Option('Contents', ''));
  const headings = model.paragraphs.filter((p) => ['h2', 'h3'].includes(p.type));
  headings.forEach((heading, index) => {
    const option = new Option(heading.text.slice(0, 72), heading.id);
    option.dataset.page = String(heading.sourcePage);
    chapterSetting.add(option);
  });
  chapterSetting.disabled = headings.length === 0;
  const supportsChapters = headings.length > 0;
  $('#previous-part').textContent = supportsChapters ? '↑ Previous section' : '↑ Previous page';
  $('#next-part').textContent = supportsChapters ? 'Next section ↓' : 'Next page ↓';
}

function navigatePart(direction) {
  if (!documentModel) return;
  if (!originalMode) {
    const headings = [...ebook.querySelectorAll('h2.reader-anchor,h3.reader-anchor')];
    if (headings.length) {
      const threshold = scrollArea.getBoundingClientRect().top + 100;
      let activeIndex = headings.findIndex((heading) => heading.getBoundingClientRect().top > threshold) - 1;
      if (activeIndex < 0) activeIndex = 0;
      const targetIndex = Math.max(0, Math.min(headings.length - 1, activeIndex + direction));
      if (headings.length) { headings[targetIndex]?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }
  }
  const page = currentSourcePage();
  const target = Math.max(1, Math.min(documentModel.totalPages, page + direction));
  if (originalMode) originalPages.querySelector(`[data-page="${target}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else ebook.querySelector(`[data-page="${target}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function navigatePdfPage(direction) {
  if (!documentModel) return;
  const target = Math.max(1, Math.min(documentModel.totalPages, currentSourcePage() + direction));
  const selector = originalMode ? `#original-page-${target}` : `#page-${target}`;
  $(selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearRenderedPages() {
  pageObserver?.disconnect();
  pageObserver = null;
  activePageElements.clear();
  for (const task of pageRenderTasks.values()) {
    try { task.cancel(); } catch { /* The render task may already be complete. */ }
  }
  pageRenderTasks.clear();
  originalPages.replaceChildren();
}

function createOriginalPages() {
  clearRenderedPages();
  for (let number = 1; number <= documentModel.totalPages; number += 1) {
    const page = document.createElement('section');
    page.className = 'pdf-page reader-anchor';
    page.dataset.page = String(number);
    page.id = `original-page-${number}`;
    page.setAttribute('aria-label', `Original PDF page ${number}`);
    page.style.aspectRatio = '0.72';
    page.dataset.rendered = 'false';
    const label = document.createElement('span');
    label.className = 'pdf-page-label';
    label.textContent = `Page ${number}`;
    page.append(label);
    originalPages.append(page);
  }
  pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const element = entry.target;
      if (entry.isIntersecting) { activePageElements.add(element); queuePageRender(element); }
      else { activePageElements.delete(element); releasePageCanvas(element); }
    }
  }, { root: scrollArea, rootMargin: '500px 0px' });
  for (const page of originalPages.children) pageObserver.observe(page);
}

function queuePageRender(element) {
  if (element.dataset.rendered === 'true' || pageRenderTasks.has(element)) return;
  pageRenderQueue = pageRenderQueue.then(async () => {
    if (!originalMode || !element.isConnected || !activePageElements.has(element) || !pdfDocument || pageRenderTasks.has(element)) return;
    const pageNumber = Number(element.dataset.page);
    const page = await pdfDocument.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(200, scrollArea.clientWidth - 24);
    const cssScale = Math.min(availableWidth / base.width, 2.4) * currentZoom;
    const viewport = page.getViewport({ scale: cssScale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(viewport.width * pixelRatio);
    canvas.height = Math.ceil(viewport.height * pixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.setAttribute('aria-label', `PDF page ${pageNumber} of ${documentModel.totalPages}`);
    element.style.aspectRatio = '';
    element.style.width = `${viewport.width}px`;
    element.style.maxWidth = '100%';
    element.append(canvas);
    const task = page.render({ canvasContext: context, viewport, transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : null });
    pageRenderTasks.set(element, task);
    try {
      await task.promise;
      if (element.isConnected && activePageElements.has(element)) element.dataset.rendered = 'true';
      else { canvas.remove(); element.dataset.rendered = 'false'; element.style.width = ''; element.style.aspectRatio = '0.72'; }
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') console.error('PDF page render failed', error);
      canvas.remove();
      element.style.width = '';
      element.style.aspectRatio = '0.72';
    } finally {
      pageRenderTasks.delete(element);
      page.cleanup();
      if (activePageElements.has(element) && element.dataset.rendered !== 'true') queuePageRender(element);
    }
  }).catch((error) => console.error('Could not queue PDF page', error));
}

function releasePageCanvas(element) {
  activePageElements.delete(element);
  const task = pageRenderTasks.get(element);
  if (task) {
    try { task.cancel(); } catch { /* Already cancelled or complete. */ }
    return;
  }
  if (element.dataset.rendered === 'true') {
    element.querySelector('canvas')?.remove();
    element.dataset.rendered = 'false';
    element.style.width = '';
    const pageNumber = Number(element.dataset.page);
    if (pdfDocument) pdfDocument.getPage(pageNumber).then((page) => {
      const viewport = page.getViewport({ scale: 1 });
      element.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      page.cleanup();
    });
  }
}

function showMode(useOriginal) {
  const page = currentSourcePage();
  originalMode = useOriginal;
  ebook.hidden = useOriginal;
  originalPages.hidden = !useOriginal;
  originalControls.hidden = !useOriginal;
  modeToggle.textContent = useOriginal ? 'Reflow reader' : 'Original PDF';
  if (useOriginal) {
    if (!originalPages.children.length) createOriginalPages();
    requestAnimationFrame(() => originalPages.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'start' }));
  } else requestAnimationFrame(() => ebook.querySelector(`#page-${page}`)?.scrollIntoView({ block: 'start' }));
  updateProgress();
}

async function openPdf(file) {
  const generation = ++loadGeneration;
  $('#reader-file-name').textContent = file.name;
  $('#reader-file-name').title = file.name;
  $('#reader-status').textContent = 'Opening locally…';
  $('#loading-state p').textContent = 'Opening your book…';
  loadingDetail.textContent = 'The document stays on this device';
  loadingState.hidden = false;
  ebook.hidden = true;
  originalPages.hidden = true;
  errorBox.hidden = true;
  dialog.showModal();
  await applyPreferences();
  scrollArea.scrollTop = 0;
  documentKey = identityFor(file);
  try {
    const [pdfjsLib, bytes] = await Promise.all([getPdfJs(), file.arrayBuffer()]);
    activeLoadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
    pdfDocument = await activeLoadingTask.promise;
    if (generation !== loadGeneration) {
      const staleTask = activeLoadingTask;
      activeLoadingTask = null;
      pdfDocument = null;
      await staleTask?.destroy();
      return;
    }
    const savedPosition = await readState(documentKey);
    documentModel = await extractPdf(pdfDocument);
    if (generation !== loadGeneration) return;
    const metadata = await pdfDocument.getMetadata().catch(() => null);
    documentModel.title = metadata?.info?.Title?.trim() || file.name.replace(/\.pdf$/i, '');
    $('#reader-file-name').textContent = documentModel.title;
    status.textContent = documentModel.processingStatus === 'scanned'
      ? `${pdfDocument.numPages} pages · no selectable text found`
      : `Reflow reader · ${pdfDocument.numPages} pages`;
    await renderReflow(documentModel);
    showMode(false);
    const paragraphs = documentModel.paragraphs.length;
    if (!paragraphs) {
      errorBox.textContent = 'This PDF appears to be scanned pages without an embedded text layer. OCR is not available yet. You can still read every page in Original PDF mode.';
      errorBox.hidden = false;
    }
    if (savedPosition) restorePosition(documentKey, savedPosition);
    updateProgress();
  } catch (error) {
    if (generation !== loadGeneration) return;
    console.error('Could not open document', error);
    loadingState.hidden = true;
    errorBox.textContent = error?.name === 'PasswordException'
      ? 'This PDF is password protected. LEAF cannot open encrypted documents yet.'
      : `Could not open this PDF. ${error?.message || 'Check that the file is valid and try again.'}`;
    errorBox.hidden = false;
    status.textContent = 'Unable to open document';
  }
}

function openEpub(file) {
  $('#reader-file-name').textContent = file.name;
  status.textContent = 'EPUB reader is not available yet';
  loadingState.hidden = true;
  ebook.hidden = false;
  ebook.replaceChildren();
  const heading = document.createElement('h1');
  heading.textContent = 'EPUB chapter rendering is still in development.';
  const paragraph = document.createElement('p');
  paragraph.textContent = 'This file was selected locally and has not been uploaded. PDF reading is available in the current reader build.';
  ebook.append(heading, paragraph);
  dialog.showModal();
}

$('#open-document').addEventListener('click', () => input.click());
input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) await openPdf(file);
  else openEpub(file);
  input.value = '';
});

$('#close-reader').addEventListener('click', async () => {
  await persistPosition();
  dialog.close();
});
dialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  void persistPosition().finally(() => dialog.close());
});
dialog.addEventListener('close', () => {
  loadGeneration += 1;
  if (activeLoadingTask) { void activeLoadingTask.destroy(); activeLoadingTask = null; }
  pageObserver?.disconnect();
  pageObserver = null;
  for (const task of pageRenderTasks.values()) { try { task.cancel(); } catch { /* Ignore completed renders. */ } }
  pageRenderTasks.clear();
  pdfDocument = null;
  documentModel = null;
  documentKey = null;
  originalMode = false;
  originalPages.replaceChildren();
  ebook.replaceChildren();
  settingsPanel.hidden = true;
  $('#settings-toggle').setAttribute('aria-expanded', 'false');
});

$('#fullscreen').addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) await dialog.requestFullscreen();
    else await document.exitFullscreen();
  } catch { /* Fullscreen may not be available in every browser. */ }
});

$('#settings-toggle').addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  $('#settings-toggle').setAttribute('aria-expanded', String(!settingsPanel.hidden));
});

for (const control of [$('#font-setting'), $('#font-size-setting'), $('#line-height-setting'), $('#width-setting'), $('#theme-setting')]) {
  control.addEventListener('input', () => { updateReaderStyles(); savePreferences(); });
  control.addEventListener('change', () => { updateReaderStyles(); savePreferences(); });
}

chapterSetting.addEventListener('change', () => {
  if (chapterSetting.value) document.getElementById(chapterSetting.value)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#previous-part').addEventListener('click', () => navigatePart(-1));
$('#next-part').addEventListener('click', () => navigatePart(1));
$('#previous-page').addEventListener('click', () => navigatePdfPage(-1));
$('#next-page').addEventListener('click', () => navigatePdfPage(1));
modeToggle.addEventListener('click', () => showMode(!originalMode));
scrollArea.addEventListener('scroll', schedulePersist, { passive: true });
scrollArea.addEventListener('scroll', updateProgress, { passive: true });
window.addEventListener('resize', () => {
  const anchor = captureAnchor();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (anchor) restoreAnchor(anchor);
    if (originalMode && documentModel) {
      const page = currentSourcePage();
      createOriginalPages();
      originalPages.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'start' });
    }
    updateProgress();
  }, 120);
});
window.addEventListener('orientationchange', () => {
  const anchor = captureAnchor();
  setTimeout(() => { if (anchor) restoreAnchor(anchor); updateProgress(); }, 250);
});
$('#zoom-in').addEventListener('click', () => {
  currentZoom = Math.min(2.5, +(currentZoom + .15).toFixed(2));
  $('#zoom-value').textContent = `${Math.round(currentZoom * 100)}%`;
  const page = currentSourcePage(); createOriginalPages();
  originalPages.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'start' });
});
$('#zoom-out').addEventListener('click', () => {
  currentZoom = Math.max(.55, +(currentZoom - .15).toFixed(2));
  $('#zoom-value').textContent = `${Math.round(currentZoom * 100)}%`;
  const page = currentSourcePage(); createOriginalPages();
  originalPages.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'start' });
});

document.addEventListener('keydown', (event) => {
  if (!dialog.open || event.target.matches('input,select,textarea,button')) return;
  if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); navigatePart(1); }
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); navigatePart(-1); }
  if (event.key === 'Escape' && !settingsPanel.hidden) { settingsPanel.hidden = true; $('#settings-toggle').setAttribute('aria-expanded', 'false'); }
});

void applyPreferences();
