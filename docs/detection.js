/*
 * Local-only PP-OCRv5 mobile text-line detection, Apache-2.0-style pipeline.
 * Reference implementations (downloaded model is separately licensed):
 * https://github.com/PaddlePaddle/PaddleOCR/blob/main/configs/det/PP-OCRv5/PP-OCRv5_mobile_det.yml
 * https://github.com/PaddlePaddle/PaddleOCR/blob/main/ppocr/postprocess/db_postprocess.py
 * https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/ch_ppocr_det/utils.py
 *
 * Engineering approximation: 8-connected components and their convex hulls
 * replace OpenCV contours; a minimum-area rectangle is expanded analytically
 * by area * unclip / perimeter instead of pyclipper's rounded polygon offset.
 * Thresholds below favor recall; they do not guarantee that every serial is found.
 * No text recognition or serial-format filtering is performed here.
 */
'use strict';
(function (scope) {
  const MODEL = 'models/det5.onnx';
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
  const MAX_BOXES = 400, MAX_COMPONENTS = 5000;
  let detectorPromise;

  async function loadDetector() {
    if (!detectorPromise) {
      detectorPromise = ort.InferenceSession.create(new URL(MODEL, scope.location.href).href,
        { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      detectorPromise.catch(() => { detectorPromise = undefined; });
    }
    return detectorPromise;
  }

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function hull(points) {
    if (points.length < 3) return points;
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const lower = [], upper = [];
    for (const p of points) { while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = points.length - 1; i >= 0; i--) { const p = points[i]; while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    lower.pop(); upper.pop(); return lower.concat(upper);
  }

  function minimumRectangle(points) {
    const poly = hull(points);
    if (poly.length < 3) return null;
    let best;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      while (angle > Math.PI / 4) angle -= Math.PI / 2;
      while (angle < -Math.PI / 4) angle += Math.PI / 2;
      const ux = Math.cos(angle), uy = Math.sin(angle), vx = -uy, vy = ux;
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      for (const p of poly) {
        const u = p[0] * ux + p[1] * uy, v = p[0] * vx + p[1] * vy;
        left = Math.min(left, u); right = Math.max(right, u); top = Math.min(top, v); bottom = Math.max(bottom, v);
      }
      // Components are pixel centers; half a pixel retains their outer edge.
      left -= 0.5; right += 0.5; top -= 0.5; bottom += 0.5;
      const area = (right - left) * (bottom - top);
      if (!best || area < best.area) best = { ux, uy, vx, vy, left, right, top, bottom, area };
    }
    return best;
  }
  function corners(r, expansion = 0) {
    const l = r.left - expansion, t = r.top - expansion, rr = r.right + expansion, b = r.bottom + expansion;
    return [[l, t], [rr, t], [rr, b], [l, b]].map(([u, v]) => [u * r.ux + v * r.vx, u * r.uy + v * r.vy]);
  }
  function rectangleScore(r, probs, width, height) {
    const points = corners(r), xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
    let sum = 0, count = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const u = x * r.ux + y * r.uy, v = x * r.vx + y * r.vy;
      if (u >= r.left && u <= r.right && v >= r.top && v <= r.bottom) { sum += probs[y * width + x]; count++; }
    }
    return count ? sum / count : 0;
  }

  function components(probs, width, height, threshold, boxThreshold, dilation, source, transform, stats) {
    const size = width * height;
    let mask = new Uint8Array(size);
    for (let i = 0; i < size; i++) mask[i] = Number(probs[i] > threshold);
    if (dilation) {
      // Symmetry is not essential for this one-pixel gap bridge; retain the
      // undilated pass as well so nearby independent lines remain selectable.
      const expanded = new Uint8Array(size);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x;
        expanded[i] = mask[i] || (x > 0 && mask[i - 1]) || (y > 0 && mask[i - width]) || (x > 0 && y > 0 && mask[i - width - 1]) ? 1 : 0;
      }
      mask = expanded;
    }
    const visited = new Uint8Array(size), queue = new Int32Array(size), boxes = [];
    let componentCount = 0;
    for (let start = 0; start < size; start++) {
      if (!mask[start] || visited[start]) continue;
      if (++componentCount > MAX_COMPONENTS) { stats.componentTruncated = true; break; }
      let tail = 1, head = 0; queue[0] = start; visited[start] = 1;
      const boundary = [];
      while (head < tail) {
        const index = queue[head++], x = index % width, y = Math.floor(index / width);
        let edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const next = yy * width + xx;
          if (!mask[next]) { edge = true; continue; }
          if (!visited[next]) { visited[next] = 1; queue[tail++] = next; }
        }
        if (edge) boundary.push([x, y]);
      }
      if (tail < 4 || boundary.length < 3) continue;
      const rect = minimumRectangle(boundary);
      if (!rect || Math.min(rect.right - rect.left, rect.bottom - rect.top) < 1.5) continue;
      const score = rectangleScore(rect, probs, width, height);
      if (!Number.isFinite(score) || score < boxThreshold) continue;
      const rw = rect.right - rect.left, rh = rect.bottom - rect.top;
      const expansion = rw * rh * 1.6 / (2 * (rw + rh));
      const polygon = corners(rect, expansion).map(([x, y]) => [
        Math.max(0, Math.min(transform.fullWidth, transform.x + x / width * transform.width)),
        Math.max(0, Math.min(transform.fullHeight, transform.y + y / height * transform.height))
      ]);
      const bx = Math.max(0, Math.min(...polygon.map(p => p[0]))), by = Math.max(0, Math.min(...polygon.map(p => p[1])));
      const bw = Math.max(...polygon.map(p => p[0])) - bx, bh = Math.max(...polygon.map(p => p[1])) - by;
      if (bw < 2 || bh < 2) continue;
      boxes.push({ polygon, box: [bx, by, bw, bh], score, source });
    }
    return boxes;
  }

  function nearlySame(a, b) {
    const aa = a.box, bb = b.box;
    const iw = Math.max(0, Math.min(aa[0] + aa[2], bb[0] + bb[2]) - Math.max(aa[0], bb[0]));
    const ih = Math.max(0, Math.min(aa[1] + aa[3], bb[1] + bb[3]) - Math.max(aa[1], bb[1]));
    const inter = iw * ih;
    if (inter / (aa[2] * aa[3] + bb[2] * bb[3] - inter) < 0.86) return false;
    const av = [a.polygon[1][0] - a.polygon[0][0], a.polygon[1][1] - a.polygon[0][1]];
    const bv = [b.polygon[1][0] - b.polygon[0][0], b.polygon[1][1] - b.polygon[0][1]];
    const denom = Math.hypot(...av) * Math.hypot(...bv);
    return denom > 0 && Math.abs((av[0] * bv[0] + av[1] * bv[1]) / denom) > 0.995;
  }
  function appendUnique(result, incoming) {
    for (const box of incoming) if (!result.some(other => nearlySame(other, box))) result.push(box);
  }

  function tileStarts(length, side) {
    if (length <= side) return [0];
    const positions = [], step = Math.max(1, Math.floor(side * 0.8));
    for (let v = 0; v < length - side; v += step) positions.push(v);
    positions.push(length - side);
    return positions.filter((v, i) => !i || v !== positions[i - 1]);
  }
  function makePasses(width, height, mode) {
    const passes = [{ x: 0, y: 0, width, height, maxSide: mode === 'detail' ? 1280 : 960, name: 'full' }];
    if (mode !== 'detail' || (Math.max(width, height) <= 1440 && Math.max(width / height, height / width) <= 1.8)) return passes;
    let side = Math.max(960, Math.ceil(Math.sqrt(width * height / 6)));
    let xs = tileStarts(width, side), ys = tileStarts(height, side);
    while (xs.length * ys.length > 12) { side = Math.ceil(side * 1.12); xs = tileStarts(width, side); ys = tileStarts(height, side); }
    for (const y of ys) for (const x of xs) {
      const w = Math.min(side, width - x), h = Math.min(side, height - y);
      if (w === width && h === height) continue;
      passes.push({ x, y, width: w, height: h, maxSide: 960, name: 'tile' });
    }
    return passes;
  }

  async function detectText(bitmap, { mode = 'default', progress = () => {} } = {}) {
    if (!bitmap || !Number.isFinite(bitmap.width) || !Number.isFinite(bitmap.height) || bitmap.width < 1 || bitmap.height < 1) throw Error('無效的本機圖片。');
    const started = performance.now(), width = bitmap.width, height = bitmap.height;
    progress({ phase: 'load-detector', model: 'det5' });
    const session = await loadDetector(), passes = makePasses(width, height, mode), boxes = [], stats = {}, passResults = [];
    for (let index = 0; index < passes.length; index++) {
      const pass = passes[index], scale = Math.min(1, pass.maxSide / Math.max(pass.width, pass.height));
      const w = Math.max(32, Math.round(pass.width * scale / 32) * 32), h = Math.max(32, Math.round(pass.height * scale / 32) * 32);
      progress({ phase: 'detect', model: 'det5', index: index + 1, total: passes.length, pass: pass.name });
      const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(bitmap, pass.x, pass.y, pass.width, pass.height, 0, 0, w, h);
      const pixels = ctx.getImageData(0, 0, w, h).data, plane = w * h, values = new Float32Array(plane * 3);
      for (let i = 0; i < plane; i++) for (let ch = 0; ch < 3; ch++) values[ch * plane + i] = (pixels[i * 4 + 2 - ch] / 255 - MEAN[ch]) / STD[ch];
      const tensor = new ort.Tensor('float32', values, [1, 3, h, w]);
      let outputs;
      const passStarted = performance.now();
      try {
        outputs = await session.run({ [session.inputNames[0]]: tensor });
        const output = outputs[session.outputNames[0]], dims = output.dims;
        const mapW = dims[dims.length - 1], mapH = dims[dims.length - 2];
        if (!mapW || !mapH || output.data.length < mapW * mapH) throw Error('文字偵測模型輸出格式不符。');
        const transform = { ...pass, fullWidth: width, fullHeight: height };
        const before = boxes.length;
        appendUnique(boxes, components(output.data, mapW, mapH, 0.30, 0.50, false, pass.name + ':standard', transform, stats));
        appendUnique(boxes, components(output.data, mapW, mapH, 0.20, 0.30, true, pass.name + ':loose', transform, stats));
        passResults.push({ ...pass, inputShape: [1, 3, h, w], added: boxes.length - before, milliseconds: performance.now() - passStarted });
      } finally {
        if (tensor.dispose) tensor.dispose();
        if (outputs) for (const output of Object.values(outputs)) if (output.dispose) output.dispose();
        c.width = 1; c.height = 1;
      }
    }
    // Preserve all credible text candidates, including Chinese and short codes.
    // A visible limit prevents pathological texture from producing an unbounded UI.
    const candidateCount = boxes.length, truncated = candidateCount > MAX_BOXES || !!stats.componentTruncated;
    if (boxes.length > MAX_BOXES) { boxes.sort((a, b) => b.score - a.score); boxes.length = MAX_BOXES; }
    boxes.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
    boxes.forEach((box, i) => { box.id = 'b' + (i + 1); });
    const warnings = [];
    if (truncated) warnings.push('候選區域過多，顯示上限為 400 框，可能還有未顯示區域；請分區重掃或使用補框。');
    if (!boxes.length) warnings.push('尚未找到文字候選，請使用「再找更多框」、旋轉圖片或補框。');
    return { boxes, width, height, milliseconds: performance.now() - started, detector: 'PP-OCRv5 mobile', mode, passes: passResults, candidateCount, truncated, warnings, postprocess: 'connected components + hull/min-area rectangle + analytic unclip' };
  }

  // Solve the inverse homography directly: destination unit square -> source quad.
  function squareToQuad(p) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(dx3) + Math.abs(dy3) < 1e-8) return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0];
    if (Math.abs(det) < 1e-8) throw Error('選取框的形狀無法校正。');
    const g = (dx3 * dy2 - dx2 * dy3) / det, h = (dx1 * dy3 - dx3 * dy1) / det;
    return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
  }
  function rectifyQuad(bitmap, polygon) {
    if (!Array.isArray(polygon) || polygon.length !== 4 || polygon.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v)))) throw Error('選取框座標無效。');
    let p = polygon.map(point => point.slice());
    let width = Math.max(distance(p[0], p[1]), distance(p[2], p[3])), height = Math.max(distance(p[0], p[3]), distance(p[1], p[2]));
    if (height / width >= 1.5) { p = [p[1], p[2], p[3], p[0]]; [width, height] = [height, width]; }
    if (width < 1 || height < 1) throw Error('選取框太小。');
    const maxSide = Math.max(width, height), scale = Math.min(1, 4096 / maxSide, Math.sqrt(4_000_000 / (width * height)));
    const outW = Math.max(1, Math.round(width * scale)), outH = Math.max(1, Math.round(height * scale));
    // Only read the selected bounding region, never allocate a full-resolution
    // source imageData for each selected line.
    const left = Math.max(0, Math.floor(Math.min(...p.map(v => v[0]))) - 1), top = Math.max(0, Math.floor(Math.min(...p.map(v => v[1]))) - 1);
    const right = Math.min(bitmap.width, Math.ceil(Math.max(...p.map(v => v[0]))) + 1), bottom = Math.min(bitmap.height, Math.ceil(Math.max(...p.map(v => v[1]))) + 1);
    if (right <= left || bottom <= top) throw Error('選取框位於圖片之外。');
    const source = new OffscreenCanvas(right - left, bottom - top), srcCtx = source.getContext('2d', { willReadFrequently: true });
    srcCtx.fillStyle = '#fff'; srcCtx.fillRect(0, 0, source.width, source.height);
    srcCtx.drawImage(bitmap, left, top, source.width, source.height, 0, 0, source.width, source.height);
    const input = srcCtx.getImageData(0, 0, source.width, source.height).data, sw = source.width, sh = source.height;
    const output = new OffscreenCanvas(outW, outH), ctx = output.getContext('2d'), image = ctx.createImageData(outW, outH), dest = image.data;
    const m = squareToQuad(p);
    for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
      const u = (x + 0.5) / outW, v = (y + 0.5) / outH, denom = m[6] * u + m[7] * v + 1;
      const sx = (m[0] * u + m[1] * v + m[2]) / denom - left - 0.5, sy = (m[3] * u + m[4] * v + m[5]) / denom - top - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0, oi = (y * outW + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let value = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const xx = x0 + dx, yy = y0 + dy, weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
          value += weight * (xx >= 0 && yy >= 0 && xx < sw && yy < sh ? input[(yy * sw + xx) * 4 + ch] : 255);
        }
        dest[oi + ch] = Math.round(value);
      }
      dest[oi + 3] = 255;
    }
    ctx.putImageData(image, 0, 0); source.width = 1; source.height = 1;
    return output;
  }

  scope.detectText = detectText;
  scope.rectifyQuad = rectifyQuad;
})(self);
