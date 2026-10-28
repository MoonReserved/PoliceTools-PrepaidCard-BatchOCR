'use strict';
// Run with Playwright installed; CHROME_BIN and PLAYWRIGHT_MODULE are optional.
// All fixtures are synthetic and generated in memory. No user files are read.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const {createHash} = require('node:crypto');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../docs');
const scope = '/PoliceTools-PrepaidCard-BatchOCR/';
const mime = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.wasm':'application/wasm', '.woff':'font/woff'};
const checks = [], errors = [], external = [], writes = [];
let browser, context, page, origin;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(scope)) { res.writeHead(404).end(); return; }
    const name = decodeURIComponent(url.pathname.slice(scope.length)) || 'index.html';
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const bytes = await fs.readFile(target);
    res.writeHead(200, {'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control':'no-cache'}).end(bytes);
  } catch { res.writeHead(404).end(); }
});
const api = (method, ...args) => page.evaluate(({method, args}) => offlineOCRTest[method](...args), {method, args});
const idle = () => api('whenIdle');
const state = () => api('getState');
const fileIn = (s, id) => s.files.find(f => f.id === id);
const boxIn = (s, id) => s.files.flatMap(f => f.boxes).find(b => b.id === id);
const bestText = box => box.result?.results[0].best.text;
async function check(name, action) {
  await action();
  checks.push({name, status:'pass'});
  console.log('PASS', name);
}
async function upload(fixtures) { await page.locator('#image').setInputFiles(fixtures); return idle(); }
async function turn(direction) {
  await page.locator(direction === 1 ? '#rotate-right' : '#rotate-left').click();
  const running = await state();
  if (running.active?.fileId === running.currentId) {
    assert(await page.locator('#rotate-left').isDisabled());
    assert(await page.locator('#rotate-right').isDisabled());
  }
  const s = await idle();
  assert(s.files.every(f => f.status !== 'error'), JSON.stringify(s.files.map(f => f.error)));
  return s;
}
async function retry(boxId) {
  await page.locator(`[data-result-id="${boxId}"]`).getByRole('button', {name:'重試', exact:true}).click();
  const s = await idle();
  assert.equal(boxIn(s, boxId).status, 'done', boxIn(s, boxId).error);
  return s;
}
async function syntheticImage({width = 1200, height = 600, sideways = false, jpeg = false, orientation = 1} = {}) {
  const data = await page.evaluate(({width, height, sideways, jpeg, orientation}) => {
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,width,height);
    const k = width / 1200; ctx.scale(k,k);
    ctx.fillStyle = '#e02020'; ctx.fillRect(10,10,30,30);
    ctx.fillStyle = '#20b040'; ctx.fillRect(1160,10,30,30);
    ctx.fillStyle = '#2040d0'; ctx.fillRect(10,560,30,30);
    ctx.fillStyle = '#000'; ctx.font = 'bold 64px Arial'; ctx.fillText('12345678901234',140,260);
    let output = c;
    if (sideways) {
      output = document.createElement('canvas'); output.width = height; output.height = width;
      const o = output.getContext('2d'); o.setTransform(0,1,-1,0,height,0); o.drawImage(c,0,0);
    }
    if (orientation > 1) {
      const raw = document.createElement('canvas'), swap = orientation >= 5;
      raw.width = swap ? height : width; raw.height = swap ? width : height;
      const transforms = {2:[-1,0,0,1,width,0],3:[-1,0,0,-1,width,height],4:[1,0,0,-1,0,height],
        5:[0,1,1,0,0,0],6:[0,-1,1,0,0,width],7:[0,-1,-1,0,height,width],8:[0,1,-1,0,height,0]};
      const ctx = raw.getContext('2d'); ctx.setTransform(...transforms[orientation]); ctx.drawImage(c,0,0); output = raw;
    }
    return output.toDataURL(jpeg ? 'image/jpeg' : 'image/png', .95).split(',')[1];
  }, {width, height, sideways, jpeg, orientation});
  return {name:jpeg?'exif.jpg':sideways?'sideways.png':'serial.png', mimeType:jpeg?'image/jpeg':'image/png', buffer:Buffer.from(data,'base64')};
}
function pdfFixture() {
  const content = '1 0 0 rg 10 270 20 20 re f\n0 1 0 rg 570 270 20 20 re f\n0 0 1 rg 10 10 20 20 re f\n0 0 0 rg BT /F1 30 Tf 70 160 Td (12345678901234) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`
  ];
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i+1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(n => `${String(n).padStart(10,'0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return {name:'two-pages.pdf', mimeType:'application/pdf', buffer:Buffer.from(pdf)};
}
function exifOrientation(jpeg, orientation) {
  // Minimal APP1 TIFF orientation tag; the browser applies this before manual turns.
  const tiff = Buffer.from([0x49,0x49,42,0,8,0,0,0,1,0,0x12,1,3,0,1,0,0,0,orientation,0,0,0,0,0,0,0]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0'),tiff]);
  const header = Buffer.alloc(4); header[0]=0xff; header[1]=0xe1; header.writeUInt16BE(payload.length+2,2);
  return {...jpeg, buffer:Buffer.concat([jpeg.buffer.subarray(0,2),header,payload,jpeg.buffer.subarray(2)])};
}
async function digest() {
  return page.evaluate(() => {
    const bitmap = state.display, c = document.createElement('canvas');
    c.width = bitmap.width; c.height = bitmap.height; const ctx = c.getContext('2d'); ctx.drawImage(bitmap,0,0);
    const data = ctx.getImageData(0,0,c.width,c.height).data;
    let hash = 2166136261; for (const byte of data) hash = Math.imul(hash ^ byte, 16777619);
    return {width:c.width,height:c.height,hash:hash>>>0};
  });
}
async function selectSerial(id) {
  const s = await state(), f = fileIn(s,id);
  const candidates = f.boxes.filter(b => b.box[2] > f.width * .25 && b.box[3] < f.height * .3);
  assert(candidates.length, 'Expected an automatically detected serial line');
  const box = candidates.reduce((a,b) => a.box[2] > b.box[2] ? a : b);
  await api('selectBox',id,box.id); const done = await idle();
  assert.equal(bestText(boxIn(done,box.id)), '12345678901234', JSON.stringify(boxIn(done,box.id)));
  return box.id;
}
async function gateRotation(id) {
  await page.evaluate(id => {
    const original = window.createImageBitmap;
    let gate = true, release;
    const wait = new Promise(resolve => release = resolve);
    window.__releaseRotation = release; window.__failRotation = false;
    window.createImageBitmap = (...args) => {
      const result = original(...args);
      if (gate && args[0] instanceof HTMLCanvasElement) {
        gate = false;
        return result.then(async bitmap => {
          await wait;
          if (window.__failRotation) { bitmap.close(); throw Error('synthetic gated failure'); }
          return bitmap;
        });
      }
      return result;
    };
    window.__restoreBitmap = () => window.createImageBitmap = original;
    window.__turn = offlineOCRTest.rotateFile(id,1);
  }, id);
}
async function releaseRotation() {
  return page.evaluate(async () => {
    window.__releaseRotation();
    try { return await window.__turn; } finally { window.__restoreBitmap(); }
  });
}
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true, ...(process.env.CHROME_BIN ? {executablePath:process.env.CHROME_BIN} : {})});
  context = await browser.newContext({viewport:{width:1280,height:900}});
  context.on('request', req => {
    if (new URL(req.url()).origin !== origin) external.push(req.url());
    if (!['GET','HEAD'].includes(req.method())) writes.push(req.url());
  });
  page = await context.newPage(); page.on('pageerror',error => errors.push(error.message));
  page.setDefaultTimeout(30000);
  await page.goto(origin+scope); await api('waitForCache');
  const image = await syntheticImage(), pdf = pdfFixture();
  let imageId, pdfId, otherPdfId, imageBox, pdfBox, baseline;
  await check('Empty controls and complete v8.2 project-scoped offline cache', async () => {
    assert(await page.locator('#rotate-left').isDisabled());
    assert(await page.locator('#rotate-right').isDisabled());
    assert.equal((await state()).version,'v8.2');
    assert((await state()).cacheReady);
  });
  await check('Mixed image and two-page PDF import with real detection and OCR', async () => {
    const s = await upload([image,pdf]); assert.equal(s.files.length,3);
    [imageId,pdfId,otherPdfId] = s.files.map(f => f.id);
    assert(s.files.every(f => f.status === 'ready'));
    baseline = await digest(); imageBox = await selectSerial(imageId);
  });
  await check('Four clockwise turns preserve image pixels, selected results, edits, verification and export order', async () => {
    const card = page.locator(`[data-result-id="${imageBox}"]`);
    await card.locator('textarea').fill('00123456789012'); await card.locator('.verified-input').check();
    const before = await state(), initial = boxIn(before,imageBox).polygon;
    for (const angle of [90,180,270,0]) {
      const s = await turn(1), f = fileIn(s,imageId), box = boxIn(s,imageBox);
      assert.equal(f.rotation,angle); assert.equal(f.width,angle%180 ? 600 : 1200);
      assert.equal(box.editedText,'00123456789012'); assert(box.verified);
      assert.deepEqual(s.selectionOrder,before.selectionOrder);
      assert.equal(await api('exportTXT'),'00123456789012');
      assert.equal(fileIn(s,pdfId).rotation,0);
      const retried = await retry(imageBox); assert.equal(bestText(boxIn(retried,imageBox)),'12345678901234');
      // Retrying invalidates verification; set it again to check the next turn.
      await card.locator('.verified-input').check();
    }
    assert.deepEqual(await digest(),baseline);
    const restored = boxIn(await state(),imageBox).polygon;
    initial.forEach((point,i) => point.forEach((value,j) => assert(Math.abs(restored[i][j]-value) < 1e-8)));
    await api('navigate',otherPdfId); await api('navigate',imageId);
    assert.deepEqual(await digest(),baseline);
  });
  await check('PDF native /Rotate plus manual counterclockwise correction, fresh detection and OCR', async () => {
    await api('navigate',pdfId); const native = fileIn(await state(),pdfId); assert(native.height > native.width);
    const corrected = await turn(-1); assert.equal(fileIn(corrected,pdfId).rotation,270);
    assert(fileIn(corrected,pdfId).width > fileIn(corrected,pdfId).height);
    pdfBox = await selectSerial(pdfId);
  });
  await check('PDF high-resolution crops and retries work at all four angles; page 2 remains independent', async () => {
    // Establish the same PDF.js viewport raster used after navigation; rotated
    // rasters may have slightly different glyph antialiasing from a fresh render.
    await api('navigate',otherPdfId); await api('navigate',pdfId);
    const before = await state(), original = fileIn(before,otherPdfId), pixels = await digest();
    for (let i=0;i<4;i++) {
      await turn(1); const s = await retry(pdfBox);
      assert.equal(bestText(boxIn(s,pdfBox)),'12345678901234');
      assert.deepEqual(fileIn(s,otherPdfId),original);
      assert.deepEqual(s.selectionOrder,before.selectionOrder);
    }
    assert.deepEqual(await digest(),pixels);
    await api('navigate',otherPdfId); await api('navigate',pdfId);
    assert.deepEqual(await digest(),pixels);
    assert((await state()).pdfStats.cropRenders >= 5);
  });
  await check('Manual selection, candidate click and TXT/CSV downloads after rotation', async () => {
    // Upright PDF page 1 has a 2560 by 1280 raster; drag a manual ROI around its line.
    const id = await api('setROI',[280,450,1600,200]);
    assert.equal(bestText(boxIn(await idle(),id)),'12345678901234');
    await page.locator('#auto-next').uncheck();
    const candidate = page.locator(`[data-box-id="${id}"]`); await candidate.click(); await candidate.click();
    await idle(); assert((await state()).selectionOrder.includes(id));
    for (const [button,method] of [['#export-txt','exportTXT'],['#export-csv','exportCSV']]) {
      const waiting = page.waitForEvent('download'); await page.locator(button).click();
      const download = await waiting;
      assert.equal(await fs.readFile(await download.path(),'utf8'),await api(method));
    }
  });
  await check('Rotation waits safely for navigation away and back; paused scans still rescan explicit turns', async () => {
    await api('pause'); await api('navigate',imageId); await gateRotation(imageId);
    assert(await page.locator('#rotate-right').isDisabled());
    assert.equal(await api('rotateFile',imageId,1),false);
    await api('navigate',otherPdfId);
    await page.evaluate(id => { window.__nav = offlineOCRTest.navigate(id); },imageId);
    await releaseRotation(); await page.evaluate(() => window.__nav); const s = await idle();
    assert.equal(s.currentId,imageId); assert.equal(fileIn(s,imageId).rotation,90); assert(s.paused);
    assert.equal(fileIn(s,imageId).status,'ready');
    assert.equal(await page.evaluate(() => state.displayId),imageId);
    const rotated = await digest(); assert.equal(rotated.width,600); assert.equal(rotated.height,1200);
    await turn(-1); assert.deepEqual(await digest(),baseline);
    await api('resume'); await idle();
  });
  await check('Rotation failure leaves image geometry and completed output intact, then can retry', async () => {
    const before = await state();
    await page.evaluate(() => {
      const original = window.createImageBitmap;
      window.createImageBitmap = (...args) => args[0] instanceof HTMLCanvasElement ? Promise.reject(Error('synthetic rotation failure')) : original(...args);
      window.__restoreBitmap = () => window.createImageBitmap = original;
    });
    await page.locator('#rotate-right').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('synthetic rotation failure'));
    await page.evaluate(() => window.__restoreBitmap());
    assert.deepEqual(fileIn(await state(),imageId),fileIn(before,imageId));
    await gateRotation(imageId); await api('navigate',otherPdfId);
    await page.evaluate(id => { window.__failRotation = true; window.__nav = offlineOCRTest.navigate(id); },imageId);
    await assert.rejects(releaseRotation(),/synthetic gated failure/); await page.evaluate(() => window.__nav);
    assert.equal((await state()).currentId,imageId); assert.deepEqual(await digest(),baseline);
    await turn(1); await turn(-1);
  });
  await check('390px controls fit the page and remain usable', async () => {
    await page.setViewportSize({width:390,height:844});
    assert(await page.locator('#rotate-left').isVisible());
    assert(await page.locator('#rotate-right').isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await turn(-1); await turn(1);
    if (process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:false});
    await page.setViewportSize({width:1280,height:900});
  });
  await check('Removal and clearing during a pending rotation do not restore deleted pages', async () => {
    await gateRotation(imageId); await api('remove',imageId); assert.equal(await releaseRotation(),false);
    await idle(); assert(!fileIn(await state(),imageId));
    await api('navigate',pdfId); await gateRotation(pdfId); await api('clear');
    assert.equal(await releaseRotation(),false); assert.equal((await state()).files.length,0);
    assert(await page.locator('#rotate-right').isDisabled());
  });
  await check('Sideways photo can be corrected and freshly recognized before selecting any text', async () => {
    await upload([await syntheticImage({sideways:true})]);
    await turn(-1); imageId=(await state()).files[0].id; await selectSerial(imageId);
  });
  await check('Downsized image retains full-resolution OCR crops after rotation and navigation', async () => {
    await api('clear'); await upload([await syntheticImage({width:3001,height:1501}),image]);
    const s = await state(); imageId=s.files[0].id; const other=s.files[1].id;
    assert.equal(s.files[0].width,2560); imageBox=await selectSerial(imageId);
    for (let i=0;i<4;i++) {
      await turn(1); await api('navigate',other); await api('navigate',imageId);
      assert.equal(bestText(boxIn(await retry(imageBox),imageBox)),'12345678901234');
    }
  });
  await check('JPEG EXIF orientation is composed with manual turns and full-resolution crops', async () => {
    await api('clear'); await upload([exifOrientation(await syntheticImage({jpeg:true}),6)]);
    imageId=(await state()).files[0].id; assert.equal((await state()).files[0].width,600);
    await turn(-1); imageBox=await selectSerial(imageId);
    await turn(1); assert.equal(bestText(boxIn(await retry(imageBox),imageBox)),'12345678901234');
  });
  await check('All eight JPEG EXIF orientations keep preview, crop and rotated retry aligned', async () => {
    for (let orientation=1;orientation<=8;orientation++) {
      await api('clear');
      await upload([exifOrientation(await syntheticImage({jpeg:true,orientation}),orientation)]);
      const s = await state(); imageId=s.files[0].id;
      assert.equal(s.files[0].width,1200); assert.equal(s.files[0].height,600);
      imageBox=await selectSerial(imageId); await turn(1);
      assert.equal(bestText(boxIn(await retry(imageBox),imageBox)),'12345678901234');
    }
  });
  await check('Offline reload supports new image/PDF rotation and actual OCR without the server', async () => {
    await api('clear'); await page.reload(); await api('waitForCache');
    await new Promise(resolve => server.close(resolve)); await context.setOffline(true);
    await page.reload(); await api('waitForCache');
    const s = await upload([image,pdf]); imageId=s.files[0].id; pdfId=s.files[1].id;
    await turn(1); await turn(-1); await selectSerial(imageId);
    await api('navigate',pdfId); await turn(-1); await selectSerial(pdfId);
    const last=await state(); assert.equal(last.metrics.maxActiveWorkerRequests,1);
    assert.equal(last.pdfStats.maxActiveRenders,1);
    assert.equal(last.pdfStats.maxActiveDocuments,1);
  });
  await check('No uncaught errors, external requests or write requests', async () => {
    assert.deepEqual(errors,[]); assert.deepEqual(external,[]); assert.deepEqual(writes,[]);
  });
  const final = await state(), hashes = {};
  for (const name of ['app.js','pdf-source.js','index.html','styles.css','offline-assets.js']) {
    hashes[name] = createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex');
  }
  const report = {metrics:final.metrics,pdf_metrics:final.pdfStats,source_sha256:hashes,release:'v8.2',status:'pass',finished_utc:new Date().toISOString(),browser:{name:'Chrome',version:browser.version(),host:process.platform},passed:checks.length,failed:0,checks,fixtures:'Synthetic PNG, JPEG with EXIF orientations 1-8, large PNG and a two-page PDF with native /Rotate 90; no user files.',limits:['Automated desktop Chrome and 390px viewport; no physical phone or Safari test.','Synthetic serials validate behavior, not accuracy across all card photos.'],uncaught_errors:errors,external_requests:external,http_write_requests:writes};
  if (process.env.REPORT_PATH) await fs.writeFile(process.env.REPORT_PATH,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,failed:0,browser:browser.version()}));
})().catch(error => { console.error(error); process.exitCode=1; }).finally(async () => { await browser?.close(); server.close(); });
