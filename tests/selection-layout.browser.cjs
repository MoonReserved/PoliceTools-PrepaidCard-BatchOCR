'use strict';
// Run with Playwright/Chrome. BASELINE_REF=HEAD before committing, HEAD^ after.
// Only synthetic images are used; the user's recording is never published.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../docs');
const baseline = execFileSync('git', ['show', `${process.env.BASELINE_REF || 'HEAD^'}:docs/styles.css`], {cwd:root});
const mime = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.wasm':'application/wasm'};
const checks = [], errors = [];
let browser;
const server = http.createServer(async (req,res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    const target = path.resolve(root,name);
    if (!target.startsWith(root+path.sep)) return res.writeHead(403).end();
    const data = name === 'baseline-styles.css' || (process.env.BASELINE_CSS && name === 'styles.css') ? baseline : await fs.readFile(target);
    res.writeHead(200, {'Content-Type':mime[path.extname(name)] || 'application/octet-stream', 'Cache-Control':'no-cache'}).end(data);
  } catch { res.writeHead(404).end(); }
});
function pass(name) { checks.push(name); console.log('PASS',name); }
(async () => {
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser = await chromium.launch({headless:true,...(process.env.CHROME_BIN ? {executablePath:process.env.CHROME_BIN} : {})});
  const page = await browser.newPage({viewport:{width:390,height:900}});
  page.on('pageerror',e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => offlineOCRTest.waitForCache());
  await page.evaluate(async () => {
    const c = document.createElement('canvas');c.width=900;c.height=1400;
    const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);
    ctx.fillStyle='#000';ctx.font='bold 55px Arial';
    for(let i=0;i<6;i++)ctx.fillText('12345678901234',80,120+i*200);
    const blob=await new Promise(resolve=>c.toBlob(resolve));
    await offlineOCRTest.addFiles([new File([blob], '12345678-90AB-CDEF-1234-567890ABCDEF.png', {type:'image/png'})]);
    await offlineOCRTest.whenIdle();await document.fonts.ready;
    // Measure without scroll anchoring masking a layout change.
    document.documentElement.style.overflowAnchor='none';
    window.layoutSnapshot=()=>Object.fromEntries(['.workspace','.file-panel','.selection-panel','.rotation-tools','#custom-rotation','.canvas-shell','#candidate-panel','.results-panel'].map(selector=>{
      const r=document.querySelector(selector).getBoundingClientRect();
      return [selector,{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}];
    }));
    window.selectionPosition=()=>{
      const r=source.getBoundingClientRect();
      return {documentY:r.y+scrollY,screenY:r.y,width:r.width,height:r.height,scrollY,innerScroll:source.parentElement.scrollTop,statusHeight:$('status').getBoundingClientRect().height};
    };
  });
  assert(await page.evaluate(()=>currentFile().boxes.length>=6));
  const widths=[320,360,375,390,393,430,520,521,600,768,800,801,1024,1280,1440];
  const normal='佇列已處理完畢。可繼續點選候選框，或核對並匯出結果。';
  for(const width of widths){
    await page.setViewportSize({width,height:900});
    await page.evaluate(normal=>{status(normal);$('rotation-status').textContent='目前方向：0°';scrollTo(0,0);},normal);
    const initial=await page.evaluate(()=>selectionPosition());
    const cases=[
      ['精讀選中框：12345678-90AB-CDEF-1234-567890ABCDEF.png · 框 10 · 1/4','目前方向：0° · 處理中'],
      ['精讀選中框：'+('很長的檔名'.repeat(30))+'.png · 框 100 · 4/4','目前方向：-179.99° · 處理中'],
      ['處理失敗：'+('請重試或改用其他圖片。'.repeat(20)),'目前方向：-179.99°'],
      [normal,'目前方向：0°']
    ];
    for(const [message,rotation] of cases){
      await page.evaluate(({message,rotation})=>{status(message);$('rotation-status').textContent=rotation;},{message,rotation});
      const actual=await page.evaluate(()=>selectionPosition());
      assert.deepEqual(actual,initial,`${width}px: status updates must not move or resize the image`);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width}px: horizontal overflow`);
    }
    // Long messages remain in full and can be scrolled inside their own area.
    await page.evaluate(()=>status('處理失敗：'+('完整錯誤訊息'.repeat(100))));
    assert(await page.evaluate(()=>{const el=$('status');el.scrollTop=el.scrollHeight;return el.scrollTop>0&&el.textContent.endsWith('完整錯誤訊息');}));
    await page.evaluate(normal=>{status(normal);$('status').scrollTop=0;},normal);
    pass(`${width}px: progress, long filenames, errors and rotation labels keep image geometry stable`);
    if(width>520){
      const updated=await page.evaluate(()=>layoutSnapshot());
      await page.evaluate(()=>new Promise((resolve,reject)=>{const link=document.querySelector('link[href="styles.css"]');link.onload=()=>document.fonts.ready.then(resolve);link.onerror=reject;link.href='baseline-styles.css';}));
      const previous=await page.evaluate(()=>layoutSnapshot());
      assert.deepEqual(updated,previous,`${width}px: normal tablet/desktop layout must match the previous release`);
      await page.evaluate(()=>new Promise((resolve,reject)=>{const link=document.querySelector('link[href="baseline-styles.css"]');link.onload=()=>document.fonts.ready.then(resolve);link.onerror=reject;link.href='styles.css';}));
      pass(`${width}px: tablet/desktop normal layout matches baseline exactly`);
    }
  }
  for(const width of [390,768,1280]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>{updateSummary();document.querySelector('.canvas-shell').scrollIntoView({block:'center'});});
    const target=await page.evaluate(()=>{const box=currentFile().boxes.find(box=>!box.result),r=source.getBoundingClientRect();return {id:box.id,x:r.x+(box.box[0]+box.box[2]/2)*r.width/currentFile().width,y:r.y+(box.box[1]+box.box[3]/2)*r.height/currentFile().height};});
    await page.evaluate(()=>{window.positions=[selectionPosition()];window.capture=setInterval(()=>positions.push(selectionPosition()),16);});
    await page.mouse.click(target.x,target.y);
    await page.evaluate(()=>offlineOCRTest.whenIdle());
    const observed=await page.evaluate(()=>{clearInterval(capture);positions.push(selectionPosition());return positions;});
    for(const sample of observed)assert.deepEqual(sample,observed[0],`${width}px: real click/OCR moved the image`);
    assert.equal(await page.evaluate(id=>findBox(state.currentId,id).status,target.id),'done');
    assert.equal(await page.evaluate(()=>offlineOCRTest.exportTXT()),'12345678901234');
    await page.mouse.click(target.x,target.y);
    assert.equal(await page.evaluate(()=>offlineOCRTest.exportTXT()),'');
    if(process.env.SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`selection-${width}.png`)});
    pass(`${width}px: actual canvas selection, OCR, cancellation and clean export without viewport movement`);
  }
  assert.deepEqual(errors,[]);
  const report={status:'pass',browser:browser.version(),finished_utc:new Date().toISOString(),widths,passed:checks.length,checks,uncaught_errors:errors,limits:['Automated Chrome at responsive viewport widths; no physical iPhone/iPad or Safari test.','Synthetic images verify interaction and layout, not recognition accuracy on every card.']};
  if(process.env.REPORT_PATH)await fs.writeFile(process.env.REPORT_PATH,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,failed:0}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();server.close();});
