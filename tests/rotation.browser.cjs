'use strict';
// Run with Playwright installed; CHROME_BIN and PLAYWRIGHT_MODULE are optional.
// Fixtures are synthetic and generated in memory. REGRESSION_IMAGE optionally
// supplies a user-approved local screen photograph for a non-publishing check.
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
const boxIn = (s, id) => s.files.flatMap(f => [...f.boxes,...f.savedResults]).find(b => b.id === id);
const bestText = box => box.result?.results[0].best.text;
async function check(name, action) {
  let timer;
  try{await Promise.race([action(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Timed out: '+name)),90000))]);}
  finally{clearTimeout(timer);}
  checks.push({name, status:'pass'});
  console.log('PASS', name);
}
async function upload(fixtures) { await page.locator('#image').setInputFiles(fixtures); return idle(); }
async function turn(direction) {
  const before = await state(), oldIds = fileIn(before,before.currentId).boxes.map(b => b.id);
  await page.locator(direction === 1 ? '#rotate-right' : '#rotate-left').click();
  const running = await state();
  if (running.active?.fileId === running.currentId) {
    assert(await page.locator('#rotate-left').isDisabled());
    assert(await page.locator('#rotate-right').isDisabled());
  }
  const s = await idle();
  assert(s.files.every(f => f.status !== 'error'), JSON.stringify(s.files.map(f => f.error)));
  const f = fileIn(s,s.currentId);
  assert(f.boxes.every(b => !oldIds.includes(b.id)), 'Old overlays must be discarded on every turn');
  assert.deepEqual(f.boxes.map(b => b.number),f.boxes.map((_,i) => i+1));
  return s;
}
async function customAngle(angle, enter=false) {
  const before=await state(),f0=fileIn(before,before.currentId),old=f0.boxes.map(b=>b.id);
  await page.locator('#rotation-angle').fill(String(angle));
  if(enter)await page.locator('#rotation-angle').press('Enter');else await page.locator('#apply-rotation').click();
  const s=await idle(),f=fileIn(s,s.currentId),normalized=((angle%360)+360)%360;
  assert(Math.abs(f.rotation-normalized)<1e-6);assert.equal(f.status,'ready');
  assert(f.width<=2560&&f.height<=2560);
  if(normalized!==f0.rotation){
    assert(f.boxes.every(b=>!old.includes(b.id)),'Custom angles must discard old overlays');
    assert.deepEqual(f.boxes.map(b=>b.number),f.boxes.map((_,i)=>i+1));
  }
  return s;
}
async function retry(boxId) {
  await page.locator(`[data-result-id="${boxId}"]`).getByRole('button', {name:'重試', exact:true}).click();
  const s = await idle();
  assert.equal(boxIn(s, boxId).status, 'done', boxIn(s, boxId).error);
  return s;
}
async function syntheticImage({width = 1200, height = 600, sideways = false, jpeg = false, orientation = 1, skew = 0} = {}) {
  const data = await page.evaluate(({width, height, sideways, jpeg, orientation, skew}) => {
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
    if (skew) {
      const r=skew*Math.PI/180, c0=Math.cos(r), s0=Math.sin(r), raw=document.createElement('canvas');
      raw.width=Math.ceil(Math.abs(width*c0)+Math.abs(height*s0));raw.height=Math.ceil(Math.abs(width*s0)+Math.abs(height*c0));
      const ctx=raw.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,raw.width,raw.height);
      ctx.translate(raw.width/2,raw.height/2);ctx.rotate(r);ctx.drawImage(c,-width/2,-height/2);output=raw;
    }
    if (orientation > 1) {
      const raw = document.createElement('canvas'), swap = orientation >= 5;
      raw.width = swap ? height : width; raw.height = swap ? width : height;
      const transforms = {2:[-1,0,0,1,width,0],3:[-1,0,0,-1,width,height],4:[1,0,0,-1,0,height],
        5:[0,1,1,0,0,0],6:[0,-1,1,0,0,width],7:[0,-1,-1,0,height,width],8:[0,1,-1,0,height,0]};
      const ctx = raw.getContext('2d'); ctx.setTransform(...transforms[orientation]); ctx.drawImage(c,0,0); output = raw;
    }
    return output.toDataURL(jpeg ? 'image/jpeg' : 'image/png', .95).split(',')[1];
  }, {width, height, sideways, jpeg, orientation, skew});
  return {name:jpeg?'exif.jpg':sideways?'sideways.png':'serial.png', mimeType:jpeg?'image/jpeg':'image/png', buffer:Buffer.from(data,'base64')};
}
function pdfFixture({skew=0}={}) {
  let content = '1 0 0 rg 10 270 20 20 re f\n0 1 0 rg 570 270 20 20 re f\n0 0 1 rg 10 10 20 20 re f\n0 0 0 rg BT /F1 30 Tf 70 160 Td (12345678901234) Tj ET\n';
  if(skew){const r=skew*Math.PI/180,c=Math.cos(r),s=Math.sin(r);content=`q ${c} ${s} ${-s} ${c} ${300-c*300+s*150} ${150-s*300-c*150} cm\n${content}Q\n`;}
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
  await check('Empty controls and complete v8.5 project-scoped offline cache', async () => {
    assert(await page.locator('#rotate-left').isDisabled());
    assert(await page.locator('#rotate-right').isDisabled());
    assert.equal((await state()).version,'v8.5');
    assert((await state()).cacheReady);
  });
  await check('Mixed image and two-page PDF import with real detection and OCR', async () => {
    const s = await upload([image,pdf]); assert.equal(s.files.length,3);
    [imageId,pdfId,otherPdfId] = s.files.map(f => f.id);
    assert(s.files.every(f => f.status === 'ready'));
    baseline = await digest(); imageBox = await selectSerial(imageId);
  });
  await check('Single-character warning, per-candidate scores and mobile layout', async () => {
    const card=page.locator(`[data-result-id="${imageBox}"]`);
    assert(await card.locator('.review-notice').isVisible());
    assert.match(await card.locator('.review-reason').textContent(),/易混淆字元/);
    await page.evaluate(({fileId,boxId})=>{
      const box=findBox(fileId,boxId);window.__originalReviewResult=box.result;
      const best={text:'AB1D',confidence:.98,charConfidence:[.999,.999,.55,.999],variant:'original',variantName:'原始裁切'};
      box.result={results:[{model:'small6',best,candidates:Array.from({length:4},(_,i)=>({...best,variant:String(i),variantName:`候選 ${i+1}`}))}]};
      box.editedText=best.text;renderResults();
    },{fileId:imageId,boxId:imageBox});
    assert(await card.locator('.review-notice').isVisible());
    assert.match(await card.locator('.review-reason').textContent(),/第 3 碼「1」0.5500/);
    assert.doesNotMatch(await card.locator('.review-reason').textContent(),/不同意見/);
    await card.getByRole('button',{name:'查看疑點與逐字分數'}).click();
    assert.equal(await card.locator(':scope > details > .character-scores > .low-score').count(),1);
    assert.equal(await card.locator(':scope > details > .character-scores > .low-score').getAttribute('data-position'),'3');
    await page.setViewportSize({width:390,height:844});
    await card.locator('.candidate-scores').first().locator('summary').click();
    assert.equal(await card.locator('.candidate-scores').first().locator('.character-score').count(),4);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert(await card.locator('.review-notice').evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
    if(process.env.REVIEW_SCREENSHOT)await card.screenshot({path:process.env.REVIEW_SCREENSHOT});
    await page.setViewportSize({width:1280,height:900});
    assert.equal(await api('exportTXT'),'AB1D');
  });
  await check('Editing, verification and adoption preserve original warning positions and clean exports', async () => {
    const card=page.locator(`[data-result-id="${imageBox}"]`);
    await card.locator('textarea').fill('ABID');await card.locator('.verified-input').check();
    assert.match(await card.locator('.review-heading').textContent(),/已核對圖片/);
    assert.match(await card.locator('.review-reason').textContent(),/本次預設結果/);
    assert.equal(await api('exportTXT'),'ABID');
    await card.locator('tbody button').first().click();
    assert.equal(await card.locator('textarea').inputValue(),'AB1D');
    assert(!await card.locator('.verified-input').isChecked());
    assert.match(await card.locator('.review-heading').textContent(),/建議加強核對/);
    assert.equal(await card.locator('.candidate-baseline').textContent(),'AB1D');
    assert.doesNotMatch(await api('exportCSV'),/⚠|低於門檻|建議加強核對/);
  });
  await check('Candidate-only disagreement, missing characters and empty candidates trigger warning', async () => {
    const card=page.locator(`[data-result-id="${imageBox}"]`);
    for(const alternate of ['ABID','ABD','']){
      await page.evaluate(({fileId,boxId,alternate})=>{
        const box=findBox(fileId,boxId),result=structuredClone(box.result),p=result.results[0];
        p.best.charConfidence=[.99,.99,.99,.99];p.candidates[2].text=alternate;
        box.result=result;renderResults();
      },{fileId:imageId,boxId:imageBox,alternate});
      assert(await card.locator('.review-notice').isVisible());
      assert.match(await card.locator('.review-reason').textContent(),/4 個候選文字有不同意見/);
      assert.doesNotMatch(await card.locator('.review-reason').textContent(),/單字低分/);
    }
  });
  await check('Perfect-score O/0/I/1, live edits and adoption keep warnings accurate without changing output', async () => {
    const card=page.locator(`[data-result-id="${imageBox}"]`);
    const setText=async text=>page.evaluate(({fileId,boxId,text})=>{
      const box=findBox(fileId,boxId),best={text,confidence:1,charConfidence:Array.from(text,()=>1),variant:'original',variantName:'原始裁切'};
      box.result={results:[{model:'small6',best,candidates:Array.from({length:4},()=>({...best}))}]};
      box.editedText=text;box.hasEdited=false;box.verified=false;renderResults();
    },{fileId:imageId,boxId:imageBox,text});
    for(const character of ['O','0','I','1','o','ｉ','０']){
      await setText(`AB${character}D`);
      assert(await card.locator('.review-notice').isVisible());
      assert.match(await card.locator('.review-reason').textContent(),/本次預設結果含/);
      assert.doesNotMatch(await card.locator('.review-reason').textContent(),/單字低分|不同意見/);
      assert.equal(await api('exportTXT'),`AB${character}D`);
    }
    await card.locator('textarea').fill('ABCD');
    assert(await card.locator('.review-notice').isVisible(), 'Original ambiguity remains after editing');
    await setText('ABCD');
    assert(await card.locator('.review-notice').isHidden());
    for(const character of ['O','0','I','1']){
      await card.locator('textarea').fill(`AB${character}D`);
      assert(await card.locator('.review-notice').isVisible());
      assert.match(await card.locator('.review-reason').textContent(),/目前內容含/);
      await card.locator('.verified-input').check();
      assert(await card.locator('.review-notice').isVisible());
      assert.match(await card.locator('.review-heading').textContent(),/已核對圖片/);
      assert.equal(await api('exportTXT'),`AB${character}D`);
      assert.doesNotMatch(await api('exportCSV'),/⚠|易混淆|查證|建議加強核對/);
      await card.locator('textarea').fill('ABCD');
      assert(!await card.locator('.verified-input').isChecked());
      assert(await card.locator('.review-notice').isHidden());
    }
    await card.locator('textarea').fill('AB0D');
    await card.locator('tbody button').first().click();
    assert.equal(await card.locator('textarea').inputValue(),'ABCD');
    assert(await card.locator('.review-notice').isHidden());
    assert.equal(await card.locator('.candidate-baseline').textContent(),'ABCD');
  });
  await check('Retry replaces low-score and disagreement data while preserving the 0/1 reminder', async () => {
    await page.evaluate(({fileId,boxId})=>{
      const box=findBox(fileId,boxId);box.result=window.__originalReviewResult;box.hasEdited=false;box.editedText=box.result.results[0].best.text;renderResults();delete window.__originalReviewResult;
    },{fileId:imageId,boxId:imageBox});
    await retry(imageBox);
    const card=page.locator(`[data-result-id="${imageBox}"]`);
    assert(await card.locator('.review-notice').isVisible());
    assert.match(await card.locator('.review-reason').textContent(),/易混淆字元/);
    assert.doesNotMatch(await card.locator('.review-reason').textContent(),/單字低分|不同意見/);
    assert.equal(await card.locator('textarea').inputValue(),'12345678901234');
    assert.equal(await card.locator(':scope > details > .character-scores > .character-score').count(),14);
    await card.locator(':scope > details').evaluate(el=>el.open=false);
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
    await page.evaluate(id => { window.__away = offlineOCRTest.navigate(id); },otherPdfId);
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
    await gateRotation(imageId); await page.evaluate(id => { window.__away = offlineOCRTest.navigate(id); },otherPdfId);
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
    await page.locator('#skew-warning').scrollIntoViewIfNeeded();
    if (process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:false});
    await page.setViewportSize({width:1280,height:900});
  });
  await check('Removal and clearing during a pending rotation do not restore deleted pages', async () => {
    await gateRotation(imageId); await page.evaluate(id=>{window.__removing=offlineOCRTest.remove(id);},imageId);
    assert.equal(await releaseRotation(),false);await page.evaluate(()=>window.__removing);
    await idle(); assert(!fileIn(await state(),imageId));
    await api('navigate',pdfId); await gateRotation(pdfId);await page.evaluate(()=>{window.__clearing=offlineOCRTest.clear();});
    assert.equal(await releaseRotation(),false);await page.evaluate(()=>window.__clearing); assert.equal((await state()).files.length,0);
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
  await check('Old image and PDF overlays disappear before replacement scans finish, including selected frames',async()=>{
    await api('clear');await upload([image,pdf]);const files=(await state()).files;
    for(const f of files.slice(0,2)){
      await api('navigate',f.id);if(f.kind==='image')await selectSerial(f.id);
      const before=fileIn(await state(),f.id),old=before.boxes.map(b=>b.id);assert(old.length>0);
      await page.evaluate(()=>{
        const original=window.callWorker;let release;const gate=new Promise(resolve=>release=resolve);
        window.__releaseDetection=()=>{window.callWorker=original;release();};
        window.callWorker=(message,...args)=>message.type==='detect'?gate.then(()=>original(message,...args)):original(message,...args);
      });
      assert.equal(await api('rotateFile',f.id,1),true);
      const scanning=fileIn(await state(),f.id);assert.equal(scanning.status,'detecting');assert.equal(scanning.boxes.length,0);
      assert.equal(await page.locator('#candidate-list .candidate-button').count(),0);
      assert(scanning.savedResults.every(b=>b.retired));
      await page.evaluate(()=>window.__releaseDetection());const done=fileIn(await idle(),f.id);
      assert(done.boxes.every(b=>!old.includes(b.id)));assert.deepEqual(done.boxes.map(b=>b.number),done.boxes.map((_,i)=>i+1));
    }
  });
  await check('Custom decimal angles, keyboard submit, warnings and fresh scans without accumulated overlays', async () => {
    await api('clear');await upload([image,pdf]);imageId=(await state()).files[0].id;
    imageBox=await selectSerial(imageId);const first=await state(),n=first.files[0].boxes.length;
    assert((await page.locator('#skew-warning').textContent()).includes('如果畫面歪斜，無法正常辨識'));
    for(const angle of [3.25,-4.5,45,135,180,270,0]){
      const s=await customAngle(angle,angle===-4.5);
      assert.deepEqual(s.selectionOrder,first.selectionOrder);
      assert.equal(s.files[0].savedResults.length,1);
      assert(s.files[0].savedResults[0].retired);
      assert.equal(await page.locator(`[data-box-id="${imageBox}"]`).count(),0);
      assert.equal(bestText(boxIn(await retry(imageBox),imageBox)),'12345678901234');
    }
    assert.equal((await state()).files[0].boxes.length,n);
    await customAngle(3.25);assert.equal(fileIn(await turn(1),imageId).rotation,93.25);
    assert.equal(fileIn(await turn(-1),imageId).rotation,3.25);await customAngle(0);
    for(const value of ['', '361','-361','2.005']){
      const before=await state();await page.locator('#rotation-angle').fill(value);
      await page.locator('#apply-rotation').click();
      assert.equal(await page.locator('#rotation-angle').evaluate(input=>input.checkValidity()),false);
      assert.deepEqual((await state()).files,before.files);
    }
    for(const angle of [361,-361,'3',null])await assert.rejects(api('rotateTo',imageId,angle));
    await page.locator('#rotation-angle').fill('0');
    const before=await state();await customAngle(0);assert.deepEqual((await state()).files,before.files);
    await page.locator(`[data-result-id="${imageBox}"]`).getByRole('button',{name:'取消選取',exact:true}).click();
    assert.equal((await state()).files[0].savedResults.length,0);assert.equal(await api('exportTXT'),'');
  });
  await check('Tilted image and native-rotated PDF accept custom correction and real OCR with source-resolution crops', async () => {
    await api('clear');await upload([await syntheticImage({skew:6.5}),pdfFixture({skew:6.25})]);
    let s=await state();imageId=s.files[0].id;pdfId=s.files[1].id;otherPdfId=s.files[2].id;
    await customAngle(-6.5);imageBox=await selectSerial(imageId);const pixels=await digest();
    await api('navigate',pdfId);const otherBefore=fileIn(await state(),otherPdfId);
    await customAngle(276.25);pdfBox=await selectSerial(pdfId);
    assert.deepEqual(fileIn(await state(),otherPdfId),otherBefore);
    await customAngle(278.5);assert.equal(bestText(boxIn(await retry(pdfBox),pdfBox)),'12345678901234');
    await api('navigate',imageId);assert.deepEqual(await digest(),pixels);
    assert.equal(bestText(boxIn(await retry(imageBox),imageBox)),'12345678901234');
    const preview=page.locator(`[data-result-id="${imageBox}"] .result-preview`);
    await preview.evaluate(img=>img.decode());assert(await preview.evaluate(img=>img.naturalWidth>img.naturalHeight*3));
  });
  if(process.env.REGRESSION_IMAGE)await check('User-supplied screen photograph rescans with fresh overlays after quarter turns and custom angles',async()=>{
    await api('clear');await upload([{name:'screen-regression.jpg',mimeType:'image/jpeg',buffer:await fs.readFile(process.env.REGRESSION_IMAGE)}]);
    const before=await state();imageId=before.files[0].id;
    await turn(1);await customAngle(-3.25);await customAngle(0);
    const f=(await state()).files[0];assert.equal(f.boxes.length,before.files[0].boxes.length);
    assert(f.boxes.length<=400);assert.equal(f.savedResults.length,0);
  });
  await check('Offline reload supports new image/PDF rotation and actual OCR without the server', async () => {
    await api('clear'); await page.reload(); await api('waitForCache');
    await new Promise(resolve => server.close(resolve)); await context.setOffline(true);
    await page.reload(); await api('waitForCache');
    const s = await upload([image,pdf]); imageId=s.files[0].id; pdfId=s.files[1].id;
    await customAngle(3.25); await customAngle(0); await selectSerial(imageId);
    await api('navigate',pdfId); await customAngle(-90); await selectSerial(pdfId);
    const last=await state(); assert.equal(last.metrics.maxActiveWorkerRequests,1);
    assert.equal(last.pdfStats.maxActiveRenders,1);
    assert.equal(last.pdfStats.maxActiveDocuments,1);
  });
  await check('Complete PDF licenses and corresponding font sources remain downloadable offline', async () => {
    const files = ['licenses/PDFJS_THIRD_PARTY_LICENSES.txt','licenses/LIBERATION_FONT_SOURCE.txt','sources/liberation-fonts-1.07.4-11-source.zip'];
    for (const name of files) {
      assert.equal(await page.locator(`a[href="${name}"]`).count() > 0, true);
      const result = await page.evaluate(async name => {
        const response = await fetch(name);
        const bytes = await response.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256',bytes);
        return {ok:response.ok,bytes:bytes.byteLength,sha256:Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')};
      },name);
      const expected = await fs.readFile(path.join(root,name));
      assert(result.ok, name);
      assert.equal(result.bytes,expected.length,name);
      assert.equal(result.sha256,createHash('sha256').update(expected).digest('hex'),name);
    }
    const downloadPromise = page.waitForEvent('download');
    await page.locator('.attribution-details').evaluate(el=>el.open=true);
    await page.locator(`a[href="${files[2]}"]`).click();
    const download = await downloadPromise;
    assert.equal(await download.failure(),null);
    const bytes = await fs.readFile(await download.path());
    assert.deepEqual(bytes,await fs.readFile(path.join(root,files[2])));
  });
  await check('Fact-check guide opens offline in a separate tab without losing work and fits mobile', async () => {
    const before=await state(),txt=await api('exportTXT');
    const popupPromise=context.waitForEvent('page');
    await page.locator('.results-panel > .hint a[href="review-guide.html"]').click();
    const guide=await popupPromise;guide.on('pageerror',error=>errors.push(error.message));
    await guide.waitForLoadState();
    assert.equal(new URL(guide.url()).pathname,scope+'review-guide.html');
    assert.equal(await guide.title(),'核對規則與品牌查證｜點數卡批次 OCR');
    assert.equal(await guide.locator('time').getAttribute('datetime'),'2026-10-30T21:03:00+08:00');
    assert.equal(await guide.locator('.brand-finding').count(),7);
    assert.match(await guide.locator('footer').textContent(),/如果連結失效，請聯繫三元所/);
    assert.equal(await guide.evaluate(()=>window.opener),null);
    assert(await guide.locator('a[href^="https://"]').evaluateAll(links=>links.length>=10&&links.every(a=>a.target==='_blank'&&a.rel.includes('noopener')&&a.rel.includes('noreferrer'))));
    for(const width of [1280,390,320]){
      await guide.setViewportSize({width,height:844});
      assert(await guide.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    await guide.getByRole('link',{name:'Google Play',exact:true}).click();
    assert.equal(new URL(guide.url()).hash,'#google-play');
    if(process.env.GUIDE_SCREENSHOT)await guide.screenshot({path:process.env.GUIDE_SCREENSHOT,fullPage:true});
    await guide.close();
    assert.equal(await api('exportTXT'),txt);
    assert.deepEqual((await state()).selectionOrder,before.selectionOrder);
    assert.equal((await state()).files.length,before.files.length);
  });
  await check('No uncaught errors, external requests or write requests', async () => {
    assert.deepEqual(errors,[]); assert.deepEqual(external,[]); assert.deepEqual(writes,[]);
  });
  const final = await state(), hashes = {};
  for (const name of ['ocr-review.js','page-rotation.js','app.js','pdf-source.js','index.html','styles.css','offline-assets.js','review-guide.html','review-guide.css']) {
    hashes[name] = createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex');
  }
  const report = {offline_run_metrics:final.metrics,offline_pdf_metrics:final.pdfStats,user_screen_regression_tested:!!process.env.REGRESSION_IMAGE,private_input_published:false,source_sha256:hashes,release:'v8.5',status:'pass',finished_utc:new Date().toISOString(),browser:{name:'Chrome',version:browser.version(),host:process.platform},passed:checks.length,failed:0,checks,fixtures:'Synthetic upright and tilted PNGs, JPEG with EXIF orientations 1-8, large PNG and upright/tilted two-page PDFs with native /Rotate 90. Optional user screen photograph tested locally without publishing the input.',limits:['Automated desktop Chrome and 390px viewport; no physical phone or Safari test.','Synthetic serials validate behavior, not accuracy across all card photos.'],uncaught_errors:errors,external_requests:external,http_write_requests:writes};
  if (process.env.REPORT_PATH) await fs.writeFile(process.env.REPORT_PATH,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,failed:0,browser:browser.version()}));
})().catch(error => { console.error(error); process.exitCode=1; }).finally(async () => { await browser?.close(); server.close(); });
