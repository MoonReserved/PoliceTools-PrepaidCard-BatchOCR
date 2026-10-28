'use strict';
// Local PDF pages are ephemeral raster sources. No viewer, scripting sandbox,
// annotation DOM, URL navigation, upload endpoint, or document persistence.
(() => {
  const VERSION = '6.4.299';
  const scriptURL = document.currentScript?.src || new URL('pdf-source.js', location.href).href;
  const assetBase = new URL('./pdfjs/', scriptURL);
  const OPEN_TIMEOUT = 30000, RENDER_TIMEOUT = 45000;
  const MAX_PAGE_PIXELS = 8000000, MAX_CROP_PIXELS = 4000000, MAX_CROP_SIDE = 8192;
  const sources = new Set(), closingDocuments = new Set();
  const metrics = {openedDocuments: 0, activeDocuments: 0, maxActiveDocuments: 0,
    pageRenders: 0, cropRenders: 0, activeRenders: 0, maxActiveRenders: 0,
    maxCanvasPixels: 0, pendingJobs: 0};
  let generation = 0, nextSource = 0, queue = Promise.resolve(), active = null;
  let libraryPromise = null, resourcePromise = null;

  function abortError() {
    const error = new Error('PDF 工作已取消。');
    error.name = 'AbortError';
    return error;
  }
  function cancelled(context) {
    return context.generation !== generation ||
      (context.source && !sources.has(context.source)) ||
      Boolean(context.isCancelled?.());
  }
  function check(context) { if (cancelled(context)) throw abortError(); }
  function readableError(error) {
    if (error?.name === 'AbortError') return error;
    if (error?.name === 'PasswordException') return new Error('此 PDF 需要密碼。請先在本機解鎖並另存為不需密碼的 PDF，再加入。');
    if (error?.name === 'InvalidPDFException') return new Error('PDF 格式損壞或不是有效的 PDF，請重新匯出後再加入。');
    if (error?.name === 'MissingPDFException') return new Error('無法讀取這份本機 PDF，請重新選取檔案。');
    return error instanceof Error ? error : new Error(String(error?.message || error || '無法處理 PDF。'));
  }
  // Cancellation is checked while a parser/render operation is awaiting a worker.
  // A late bitmap is explicitly closed if its consumer has already gone away.
  function waitFor(promise, context, milliseconds, message, onCancel, disposeLate) {
    return new Promise((resolve, reject) => {
      let settled = false, timer, poll;
      const clear = () => { clearTimeout(timer); clearInterval(poll); };
      const fail = error => {
        if (settled) return;
        settled = true; clear();
        try { Promise.resolve(onCancel?.()).catch(() => {}); } catch (_) {}
        reject(error);
      };
      try { check(context); } catch (error) { fail(error); }
      if (!settled) {
        timer = setTimeout(() => fail(new Error(message)), milliseconds);
        poll = setInterval(() => { try { check(context); } catch (error) { fail(error); } }, 100);
      }
      Promise.resolve(promise).then(value => {
        if (settled) { try { disposeLate?.(value); } catch (_) {} return; }
        try { check(context); } catch (error) {
          try { disposeLate?.(value); } catch (_) {}
          fail(error); return;
        }
        settled = true; clear(); resolve(value);
      }, error => {
        if (settled) return;
        settled = true; clear(); reject(error);
      });
    });
  }
  function serial(source, isCancelled, action) {
    const context = {source, isCancelled, generation};
    metrics.pendingJobs++;
    const task = queue.then(async () => {
      check(context);
      try { return await action(context); }
      catch (error) { if (cancelled(context)) throw abortError(); throw readableError(error); }
    }).finally(() => { metrics.pendingJobs--; });
    queue = task.catch(() => {});
    return task;
  }
  async function fetchPublic(path, type) {
    const url = new URL(path, assetBase);
    if (url.origin !== location.origin || !url.href.startsWith(assetBase.href)) throw new Error('PDF 公開資源路徑不正確。');
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), OPEN_TIMEOUT);
    try {
      const response = await fetch(url, {credentials: 'omit', redirect: 'error', signal: controller.signal});
      if (!response.ok) throw new Error(`PDF 離線資源讀取失敗（${response.status}），請確認網站檔案完整。`);
      return type === 'json' ? await response.json() : new Uint8Array(await response.arrayBuffer());
    } finally { clearTimeout(timeout); }
  }
  function resources() {
    if (!resourcePromise) resourcePromise = Promise.all([
      fetchPublic('resources.json', 'json'), fetchPublic('resources.pack', 'bytes')
    ]).then(([index, bytes]) => {
      if (index.format !== 'pdfjs-offline-pack-v1' || index.version !== VERSION ||
          index.byteLength !== bytes.length || !index.entries || bytes.length > 8 * 1024 * 1024) {
        throw new Error('PDF 離線資源版本或大小不一致，請重新載入完整網站。');
      }
      return {index, bytes};
    }).catch(error => { resourcePromise = null; throw error; });
    return resourcePromise;
  }
  class PackedBinaryDataFactory {
    async fetch({kind, filename}) {
      const directory = {cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm'}[kind];
      if (!directory || typeof filename !== 'string' || !filename || filename.length > 200 ||
          filename.includes('..') || /[\\/]/.test(filename)) throw new Error('PDF 要求了不支援的內建資源。');
      const {index, bytes} = await resources(), key = `${directory}/${filename}`;
      const entry = Object.prototype.hasOwnProperty.call(index.entries, key) && index.entries[key];
      if (!entry || !Number.isSafeInteger(entry.offset) || !Number.isSafeInteger(entry.length) ||
          entry.offset < 0 || entry.length <= 0 || entry.offset + entry.length > bytes.length) {
        throw new Error(`PDF 離線資源缺少 ${key}。`);
      }
      // A copy prevents worker transfers from detaching the shared public pack.
      return bytes.slice(entry.offset, entry.offset + entry.length);
    }
  }
  function library() {
    if (!libraryPromise) libraryPromise = import(new URL('pdf.min.mjs', assetBase).href).then(pdfjs => {
      if (pdfjs.version !== VERSION) throw new Error('PDF 解析器版本不一致，請重新載入完整網站。');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', assetBase).href;
      return pdfjs;
    }).catch(error => { libraryPromise = null; throw error; });
    return libraryPromise;
  }
  async function closeRecord(record) {
    if (!record) return;
    if (active === record) active = null;
    record.cancelled = true;
    try { record.renderTask?.cancel(); } catch (_) {}
    if (!record.closing) {
      record.closing = (async () => {
        try { await record.loadingTask?.destroy(); } catch (_) {}
        finally {
          if (record.counted) { record.counted = false; metrics.activeDocuments--; }
          record.document = null;
        }
      })();
      closingDocuments.add(record.closing);
      record.closing.then(() => closingDocuments.delete(record.closing));
    }
    return record.closing;
  }
  async function waitForClosedDocuments(context) {
    // release() interrupts a current document immediately, outside the serial
    // queue. Its worker must finish destruction before a replacement opens.
    while (closingDocuments.size) {
      await waitFor(Promise.all([...closingDocuments]), context, OPEN_TIMEOUT,
        '釋放前一份 PDF 資源逾時，請先匯出結果並重新開啟頁面。');
    }
  }
  async function documentFor(source, context) {
    check(context);
    if (active?.source === source && active.document && !active.cancelled) return active;
    closeRecord(active);
    await waitForClosedDocuments(context);
    check(context);
    const pdfjs = await waitFor(library(), context, OPEN_TIMEOUT, 'PDF 解析器載入逾時，請確認離線資源完整。');
    check(context);
    const record = {source, document: null, loadingTask: null, renderTask: null, counted: false, cancelled: false, closing: null};
    active = record;
    try {
      const buffer = await waitFor(source.file.arrayBuffer(), context, OPEN_TIMEOUT, '讀取 PDF 逾時，請改用較小的檔案。');
      check(context);
      if (record.cancelled || active !== record) throw abortError();
      record.loadingTask = pdfjs.getDocument({
        data: new Uint8Array(buffer),
        cMapUrl: new URL('cmaps/', assetBase).href, cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', assetBase).href,
        wasmUrl: new URL('wasm/', assetBase).href,
        BinaryDataFactory: PackedBinaryDataFactory, useWorkerFetch: false,
        disableFontFace: true, useSystemFonts: false, enableXfa: false,
        // Older PDF.js versions used this switch; 6.x removed dynamic font eval.
        isEvalSupported: false,
        useWasm: true, stopAtErrors: true, maxImageSize: -1,
        canvasMaxAreaInBytes: 24 * 1024 * 1024,
        disableAutoFetch: true, disableRange: true, disableStream: true,
        verbosity: pdfjs.VerbosityLevel.ERRORS
      });
      const document = await waitFor(record.loadingTask.promise, context, OPEN_TIMEOUT,
        '解析 PDF 超過 30 秒，請先在本機拆成較小檔案後再加入。', () => closeRecord(record));
      check(context);
      if (record.cancelled || active !== record) throw abortError();
      record.document = document; record.counted = true;
      metrics.openedDocuments++; metrics.activeDocuments++;
      metrics.maxActiveDocuments = Math.max(metrics.maxActiveDocuments, metrics.activeDocuments);
      return record;
    } catch (error) { await closeRecord(record); throw error; }
  }
  function pageViewport(page, rotation = 0) {
    const viewport = page.getViewport({scale: 1, rotation: (page.rotate + rotation) % 360});
    if (![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0 && value <= 10000000)) {
      throw new Error('PDF 頁面尺寸異常，請先重新匯出或縮小頁面。');
    }
    return viewport;
  }
  async function withPage(source, pageNumber, context, action, rotation = 0) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > source.pageCount) throw new Error('PDF 頁碼超出範圍。');
    const record = await documentFor(source, context);
    let page;
    try {
      page = await waitFor(record.document.getPage(pageNumber), context, OPEN_TIMEOUT,
        '讀取 PDF 頁面逾時，請先在本機拆成較小檔案。', () => closeRecord(record), value => value.cleanup());
      check(context);
      return await action(page, pageViewport(page, rotation), record);
    } catch (error) {
      // A failed parser or cancelled render is not reused by a subsequent page.
      await closeRecord(record);
      throw error;
    } finally { try { page?.cleanup(); } catch (_) {} }
  }
  async function raster(page, viewport, record, context, width, height, transform) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', {alpha: false});
    if (!ctx) { canvas.width = canvas.height = 0; throw new Error('瀏覽器無法建立 PDF 頁面畫布。'); }
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    metrics.activeRenders++;
    metrics.maxActiveRenders = Math.max(metrics.maxActiveRenders, metrics.activeRenders);
    metrics.maxCanvasPixels = Math.max(metrics.maxCanvasPixels, width * height);
    try {
      check(context);
      // Appearance streams (e.g. printed form values) are painted, but no
      // annotation layer, navigation actions, or PDF JavaScript are executed.
      record.renderTask = page.render({canvasContext: ctx, viewport, transform,
        annotationMode: 1, background: 'rgb(255,255,255)', intent: 'display'});
      await waitFor(record.renderTask.promise, context, RENDER_TIMEOUT,
        '繪製 PDF 頁面超過 45 秒，請先降低解析度或拆分檔案。', () => closeRecord(record));
      record.renderTask = null;
      check(context);
      return await waitFor(createImageBitmap(canvas), context, RENDER_TIMEOUT,
        '建立 PDF 頁面預覽逾時，請改用較小的頁面。', () => closeRecord(record), bitmap => bitmap.close());
    } finally {
      record.renderTask = null;
      canvas.width = canvas.height = 0;
      metrics.activeRenders--;
    }
  }
  async function inspect(file, {isCancelled} = {}) {
    if (!(file instanceof Blob) || file.size === 0 || file.size > 50 * 1024 * 1024) throw new Error('PDF 必須是非空白的本機檔案，且不能超過 50 MiB。');
    const source = {id: `pdf${++nextSource}`, file, pageCount: 0};
    sources.add(source);
    try {
      return await serial(source, isCancelled, async context => {
        const record = await documentFor(source, context), count = record.document.numPages;
        if (!Number.isSafeInteger(count) || count < 1) throw new Error('PDF 沒有可讀取的頁面。');
        source.pageCount = count;
        return source;
      });
    } catch (error) { await release(source); throw readableError(error); }
  }
  function renderPage(source, pageNumber, {maxSide = 2560, rotation = 0, isCancelled} = {}) {
    return serial(source, isCancelled, context => withPage(source, pageNumber, context, async (page, viewport, record) => {
      const side = Math.min(4096, Math.max(32, Number(maxSide) || 2560));
      const scale = Math.min(side / Math.max(viewport.width, viewport.height), Math.sqrt(MAX_PAGE_PIXELS / (viewport.width * viewport.height)));
      const width = Math.max(1, Math.floor(viewport.width * scale)), height = Math.max(1, Math.floor(viewport.height * scale));
      // Use exact raster dimensions on both axes, so ROI coordinates map back
      // without ambiguity caused by fractional viewport edge rounding.
      const bitmap = await raster(page, viewport, record, context, width, height,
        [width / viewport.width, 0, 0, height / viewport.height, 0, 0]);
      metrics.pageRenders++;
      return {bitmap, width, height};
    }, rotation));
  }
  function renderCrop(source, pageNumber, {workingWidth, workingHeight, polygon, rotation = 0, isCancelled} = {}) {
    return serial(source, isCancelled, context => withPage(source, pageNumber, context, async (page, viewport, record) => {
      if (!Number.isFinite(workingWidth) || !Number.isFinite(workingHeight) || workingWidth <= 0 || workingHeight <= 0 ||
          !Array.isArray(polygon) || polygon.length !== 4 || !polygon.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) {
        throw new Error('PDF 選框座標不正確，請重新選取候選框。');
      }
      const points = polygon.map(([x, y]) => [Math.max(0, Math.min(workingWidth, x)), Math.max(0, Math.min(workingHeight, y))]);
      const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      if (maxX <= minX || maxY <= minY) throw new Error('PDF 選框範圍太小。');
      let density = Math.max(300 / 72, workingWidth / viewport.width, workingHeight / viewport.height);
      const cropWidth = (maxX - minX) / workingWidth * viewport.width;
      const cropHeight = (maxY - minY) / workingHeight * viewport.height;
      // Small margin in the limits accounts for floor/ceil of bounding edges.
      density = Math.min(density, (MAX_CROP_SIDE - 2) / Math.max(cropWidth, cropHeight),
        Math.sqrt((MAX_CROP_PIXELS - 2 * MAX_CROP_SIDE) / (cropWidth * cropHeight)));
      const sx = viewport.width * density / workingWidth, sy = viewport.height * density / workingHeight;
      const left = Math.floor(minX * sx), top = Math.floor(minY * sy);
      const width = Math.max(1, Math.ceil(maxX * sx) - left), height = Math.max(1, Math.ceil(maxY * sy) - top);
      if (width * height > MAX_CROP_PIXELS || width > MAX_CROP_SIDE || height > MAX_CROP_SIDE) throw new Error('PDF 選框過大，請改選較小的文字行。');
      const bitmap = await raster(page, viewport, record, context, width, height, [density, 0, 0, density, -left, -top]);
      metrics.cropRenders++;
      return {bitmap, polygon: points.map(([x, y]) => [x * sx - left, y * sy - top])};
    }, rotation));
  }
  function release(source) {
    if (!source) return Promise.resolve();
    sources.delete(source);
    return active?.source === source ? closeRecord(active) : Promise.resolve();
  }
  function reset() {
    generation++; sources.clear();
    const stopped = closeRecord(active), pending = queue;
    queue = (async () => {
      await Promise.all([pending.catch(() => {}), stopped]);
      while (closingDocuments.size) await Promise.all([...closingDocuments]);
    })();
    return queue;
  }
  function getStats() {
    return {...metrics, pdfjsVersion: VERSION, retainedSources: sources.size, closingDocuments: closingDocuments.size,
      activeSourceId: active?.source.id || null, generation};
  }
  window.OfflinePDF = Object.freeze({inspect, renderPage, renderCrop, release, reset, getStats});
})();
