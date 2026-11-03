'use strict';
// Deterministic OCR worker for race coverage; real image decoding and PDF.js.
// The separate rotation suite exercises the unchanged real OCR models.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../docs'),checks=[],errors=[];
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json'};
const worker=`onmessage=({data:m})=>{const result=m.type==='detect'?{boxes:[{box:[40,40,300,45]},{box:[40,120,300,45]}]}:{results:[{model:'small6',best:{text:'123456',confidence:.98,charConfidence:[.98,.98,.98,.98,.98,.98],variantName:'原圖'},candidates:[{text:'123456',confidence:.98,variantName:'原圖'},{text:'123458',confidence:.95,variantName:'候選'}]}]};m.bitmap?.close();setTimeout(()=>postMessage({requestId:m.requestId,type:'done',result}),250);};`;
const server=http.createServer(async(req,res)=>{
  try{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html',target=path.resolve(root,name);
    if(!target.startsWith(root+path.sep))return res.writeHead(403).end();
    res.setHeader('Content-Type',mime[path.extname(name)]||'application/octet-stream');res.end(await fs.readFile(target));
  }catch{res.writeHead(404).end();}
});
let browser,context,page,url,fixture;
const api=(method,...args)=>page.evaluate(({method,args})=>offlineOCRTest[method](...args),{method,args});
const idle=()=>api('whenIdle');
const snapshot=()=>api('getState');
const text=()=>api('exportTXT');
const firstInput=()=>page.locator('.result-value').first();
async function check(name,fn){await fn();checks.push(name);console.log('PASS',name);}
async function fresh(){if(page)await page.close();page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);await page.goto(url);}
async function upload(files=[fixture]){await page.locator('#image').setInputFiles(files);return idle();}
async function selected(){const s=await upload(),f=s.files[0];await api('selectBox',f.id,f.boxes[0].id);await idle();return f;}
async function undo(){await page.locator('#undo').click();await idle();}
async function redo(){await page.locator('#redo').click();await idle();}
function pdfFixture(){
 const content='BT /F1 24 Tf 40 150 Td (123456) Tj ET\n';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`];
 let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=Buffer.byteLength(pdf);
 pdf+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return {name:'history.pdf',mimeType:'application/pdf',buffer:Buffer.from(pdf)};
}
(async()=>{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});url=`http://127.0.0.1:${server.address().port}/`;
 browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
 context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
 await context.route('**/ocr-worker.js',route=>route.fulfill({contentType:'text/javascript',body:worker}));
 await fresh();
 fixture={name:'history.png',mimeType:'image/png',buffer:Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=300;const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,600,300);ctx.fillStyle='black';ctx.font='32px Arial';ctx.fillText('123456',40,80);return c.toDataURL().split(',')[1];}),'base64')};
 await check('Empty page shows the notice below offline status without prompting on exit',async()=>{assert(await page.locator('#undo').isDisabled());assert(await page.locator('#redo').isDisabled());assert(await page.locator('#leave-warning').isVisible());assert(await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))));
   assert(await page.locator('#leave-warning').evaluate(el=>el.previousElementSibling.id==='cache-status'));
   for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});const warning=await page.locator('#leave-warning').boundingBox(),offline=await page.locator('#cache-status').boundingBox();assert(warning.y>=offline.y+offline.height&&warning.y+warning.height<=900);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
   await page.setViewportSize({width:1280,height:900});
   if(process.env.NOTICE_SCREENSHOT_PATH)await page.screenshot({path:process.env.NOTICE_SCREENSHOT_PATH});
 });
 await check('Import undo/redo restores all pages and completed detection',async()=>{
   const imported=await upload();await undo();assert.equal((await snapshot()).files.length,0);await redo();assert.deepEqual((await snapshot()).files,imported.files);
   await fresh();
 });
 await check('Typing is grouped; Ctrl/Cmd undo and redo preserve verified state and focus',async()=>{
   await selected();await page.locator('.verified-input').first().check();await firstInput().focus();await firstInput().press('End');await firstInput().pressSequentially('789',{delay:40});assert.equal(await text(),'123456789');const scroll=await page.evaluate(()=>({y:scrollY,h:document.getElementById('source').getBoundingClientRect().height}));
   await page.keyboard.press('Control+z');await idle();assert.equal(await text(),'123456');const after=await page.evaluate(()=>({y:scrollY,h:document.getElementById('source').getBoundingClientRect().height}));assert.equal(after.h,scroll.h);assert(Math.abs(after.y-scroll.y)<40,'undo should not collapse the image or jump the page');assert(await page.locator('.verified-input').first().isChecked());assert.equal(await firstInput().evaluate(e=>e===document.activeElement),true);assert.equal(await page.locator('#history-notice').textContent(),'已恢復');
   await page.keyboard.press('Meta+Shift+z');await idle();assert.equal(await text(),'123456789');assert.equal(await page.locator('#history-notice').textContent(),'取消恢復');
   await page.keyboard.press('Meta+z');await idle();assert.equal(await text(),'123456');await page.keyboard.press('Control+y');await idle();assert.equal(await text(),'123456789');
 });
 await check('Candidate adoption and native beforeinput undo/redo restore exact text',async()=>{
   await page.locator('.result-card').first().locator('summary').filter({hasText:'檢視辨識候選'}).click();await page.locator('.recognition-table button').nth(1).click();assert.equal(await text(),'123458');await undo();assert.equal(await text(),'123456789');await redo();assert.equal(await text(),'123458');
   await firstInput().evaluate(e=>e.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'historyUndo'})));await idle();assert.equal(await text(),'123456789');
   await firstInput().evaluate(e=>e.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'historyRedo'})));await idle();assert.equal(await text(),'123458');
 });
 await check('Clear undo/redo restores selections, previews, manual edits and exports',async()=>{
   const before=await snapshot(),out=await api('exportCSV');await page.locator('#clear').click();assert.equal((await snapshot()).files.length,0);assert(await page.locator('#leave-warning').isVisible());await undo();assert.equal(await api('exportCSV'),out);assert.deepEqual((await snapshot()).selectionOrder,before.selectionOrder);
   assert(await page.locator('.result-preview').first().evaluate(img=>img.complete&&img.naturalWidth>0));await redo();assert.equal((await snapshot()).files.length,0);await undo();assert.equal(await text(),'123458');
 });
 await check('New edit after undo discards redo and keeps later text',async()=>{await firstInput().fill('new text');await undo();assert.equal(await text(),'123458');await firstInput().fill('replacement');assert(await page.locator('#redo').isDisabled());await undo();assert.equal(await text(),'123458');});
 await check('Selection, manual box and output ordering restore together',async()=>{
   let s=await snapshot(),f=s.files[0];await api('selectBox',f.id,f.boxes[1].id);await idle();await api('moveSelection',f.boxes[1].id,-1);assert.equal((await snapshot()).selectionOrder[0],f.boxes[1].id);await undo();assert.equal((await snapshot()).selectionOrder[0],f.boxes[0].id);await undo();assert.equal((await snapshot()).selectionOrder.length,1);await redo();assert.equal((await snapshot()).selectionOrder.length,2);
   const before=(await snapshot()).files[0].boxes.length;await api('setROI',[40,200,280,45]);await idle();assert.equal((await snapshot()).files[0].boxes.length,before+1);await undo();assert.equal((await snapshot()).files[0].boxes.length,before);await redo();assert.equal((await snapshot()).files[0].boxes.length,before+1);
 });
 await check('Remove page and page ordering can be recovered',async()=>{
   const s=await upload([{...fixture,name:'second.png'}]),ids=s.files.map(f=>f.id);await api('moveFile',ids[1],-1);assert.deepEqual((await snapshot()).files.map(f=>f.id),ids.toReversed());await undo();assert.deepEqual((await snapshot()).files.map(f=>f.id),ids);await api('remove',ids[0]);assert.equal((await snapshot()).files.length,1);await undo();assert.deepEqual((await snapshot()).files.map(f=>f.id),ids);assert.equal((await snapshot()).selectionOrder.length,3);
 });
 await check('Rotation and retry preserve completed edits across undo',async()=>{
   const f=(await snapshot()).files[0];await api('navigate',f.id);await firstInput().fill('kept after turn');await page.locator('.verified-input').first().check();await api('rotateTo',f.id,90);await idle();assert.equal((await snapshot()).files[0].rotation,90);await undo();assert.equal((await snapshot()).files[0].rotation,0);assert.equal(await firstInput().inputValue(),'kept after turn');assert(await page.locator('.verified-input').first().isChecked());await redo();assert.equal((await snapshot()).files[0].rotation,90);
   await page.locator('.result-card').first().getByRole('button',{name:'重試',exact:true}).click();await undo();assert(await page.locator('.verified-input').first().isChecked());assert.equal(await firstInput().inputValue(),'kept after turn');
 });
 await check('In-flight OCR cannot overwrite undone/cleared state',async()=>{
   await fresh();const f=(await upload()).files[0];await api('selectBox',f.id,f.boxes[0].id);await api('undo');await idle();assert.equal((await snapshot()).selectionOrder.length,0);await api('redo');await page.locator('#clear').click();await undo();await idle();assert.equal(await text(),'123456');assert.equal((await snapshot()).files[0].boxes[0].status,'done');
 });
 await check('Clear during background detection resumes exactly one scan after recovery',async()=>{
   await fresh();await page.locator('#image').setInputFiles(fixture);await page.waitForFunction(()=>offlineOCRTest.getState().active?.type==='detect');await page.locator('#clear').click();await undo();const restored=await idle();assert.equal(restored.files.length,1);assert.equal(restored.files[0].status,'ready');assert.equal(restored.files[0].boxes.length,2);assert.equal(restored.metrics.maxActiveWorkerRequests,1);
 });
 await check('Output filter, edits and paused queues are restored',async()=>{
   await fresh();await selected();await page.locator('.verified-input').first().check();await page.locator('#verified-only').check();assert.equal(await text(),'123456');await firstInput().fill('changed');assert.equal(await text(),'');await undo();assert.equal(await text(),'123456');await undo();assert.equal(await page.locator('#verified-only').isChecked(),false);
   await api('pause');await upload([{...fixture,name:'waiting.png'}]);await page.locator('#clear').click();await undo();assert.equal((await snapshot()).paused,true);assert.equal((await snapshot()).pendingDetection.length,1);await api('resume');await idle();assert((await snapshot()).files.every(f=>f.status==='ready'));
 });
 await check('PDF clear and remove recovery reopens the source for navigation and OCR',async()=>{
   await fresh();const f=(await upload([pdfFixture()])).files[0];await api('selectBox',f.id,f.boxes[0].id);await idle();await firstInput().fill('PDF restored');await page.locator('#clear').click();await undo();assert.equal(await text(),'PDF restored');await page.locator('.result-card').first().getByRole('button',{name:'重試',exact:true}).click();await idle();assert.equal((await snapshot()).files[0].boxes[0].status,'done');await api('remove',f.id);await undo();await page.waitForFunction(()=>!document.getElementById('rotate-right').disabled);await api('rotateTo',f.id,90);await idle();assert.equal((await snapshot()).files[0].rotation,90);assert.equal(await text(),'PDF restored');
 });
 await check('IME composition is one action and history keys do not interfere with angle input',async()=>{
   await firstInput().focus();const before=await firstInput().inputValue();await firstInput().dispatchEvent('compositionstart');await firstInput().fill('中文');assert(await page.locator('#undo').isDisabled());await firstInput().dispatchEvent('compositionend');await page.keyboard.press('Control+z');await idle();assert.equal(await firstInput().inputValue(),before);
   const count=(await snapshot()).editHistory.undo;await page.locator('#rotation-angle').fill('12');await page.locator('#rotation-angle').press('Control+z');assert.equal((await snapshot()).editHistory.undo,count);
 });
 await check('History cap releases discarded preview URLs without breaking live previews',async()=>{
   await fresh();await selected();await page.evaluate(()=>{window.__revoked=[];const original=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.__revoked.push(url);original(url);};});
   const oldURL=await page.locator('.result-preview').first().getAttribute('src');await page.locator('.result-card').first().getByRole('button',{name:'重試',exact:true}).click();await idle();
   for(let i=0;i<55;i++)await page.locator('.verified-input').first().click();assert.equal((await snapshot()).editHistory.undo,50);assert(await page.evaluate(url=>window.__revoked.includes(url),oldURL));assert(await page.locator('.result-preview').first().evaluate(e=>e.complete&&e.naturalWidth>0));
 });
 await check('Floating controls stay within desktop/mobile viewport and notice fades',async()=>{
   for(const width of [1280,768,390,320]){await page.setViewportSize({width,height:800});await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));const r=await page.locator('.history-buttons').boundingBox();assert(r.x>=0&&r.x+r.width<=width&&r.y+r.height<=800);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
   await undo();await page.waitForTimeout(2600);assert.equal(await page.locator('#history-notice').evaluate(e=>getComputedStyle(e).opacity),'0');if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH});
 });
 await check('Reload and navigation ask before leaving; dismiss preserves data',async()=>{
   await page.setViewportSize({width:1280,height:900});await firstInput().fill('stay here');
   for(const action of [()=>page.reload(),()=>page.goto('about:blank')]){const dialogPromise=page.waitForEvent('dialog');const navigation=action().catch(()=>{});const dialog=await dialogPromise;assert.equal(dialog.type(),'beforeunload');await dialog.dismiss();await navigation;assert.equal(await text(),'stay here');}
   const dialogPromise=page.waitForEvent('dialog');const reload=page.reload();const dialog=await dialogPromise;await dialog.accept();await reload;assert.equal((await snapshot()).files.length,0);assert(await page.locator('#undo').isDisabled());assert(await page.locator('#leave-warning').isVisible());
 });
 await check('Browser Back confirms in-page, Cancel preserves work, and Leave really exits',async()=>{
   await page.goto(url+'review-guide.html');await page.goto(url);await selected();await firstInput().fill('keep navigation work');
   const length=await page.evaluate(()=>history.length);
   for(let attempt=0;attempt<3;attempt++){
     await page.goBack({timeout:1000}).catch(error=>{if(error.name!=='TimeoutError')throw error;});await page.locator('#leave-dialog').waitFor({state:'visible'});
     assert.match(await page.locator('#leave-dialog-description').textContent(),/資料與復原紀錄會消失/);
     await page.keyboard.press('Control+z');assert.equal(await text(),'keep navigation work','history shortcuts must not edit work behind the modal');
     await page.locator('#stay-on-page').click();assert.equal(await text(),'keep navigation work');assert.equal(page.url(),url);assert.equal(await page.evaluate(()=>history.length),length);
   }
   // Changing the address still uses the browser's native confirmation.
   const addressDialog=page.waitForEvent('dialog');const addressNavigation=page.goto(url+'review-guide.html').catch(()=>{});await (await addressDialog).dismiss();await addressNavigation;assert.equal(await text(),'keep navigation work');
   await page.locator('#clear').click();await page.goBack({timeout:1000}).catch(error=>{if(error.name!=='TimeoutError')throw error;});await page.locator('#leave-dialog').waitFor({state:'visible'});await page.keyboard.press('Escape');await undo();assert.equal(await text(),'keep navigation work');
   await page.goBack({timeout:1000}).catch(error=>{if(error.name!=='TimeoutError')throw error;});await page.locator('#leave-dialog').waitFor({state:'visible'});
   const unexpected=[];page.on('dialog',async dialog=>{unexpected.push(dialog.type());await dialog.dismiss();});
   await page.locator('#leave-page').click();await page.waitForURL(url+'review-guide.html');assert.deepEqual(unexpected,[],'confirmed Back should not ask twice');
   await page.goForward();await page.waitForFunction(()=>typeof offlineOCRTest!=='undefined');
   // Forward may restore from BFCache. A new import must still protect Back.
   await upload();await page.goBack({timeout:1000}).catch(error=>{if(error.name!=='TimeoutError')throw error;});await page.locator('#leave-dialog').waitFor({state:'visible'});await page.locator('#stay-on-page').click();assert((await snapshot()).files.length>0);
 });
 assert.deepEqual(errors,[]);const report={status:'pass',release:'v8.7.1',checks,passed:checks.length,browser:browser.version(),ocr:'deterministic delayed worker; real image/PDF decoding',uncaught_errors:errors};if(process.env.REPORT_PATH)await fs.writeFile(process.env.REPORT_PATH,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{server.closeAllConnections();server.close();server.unref();await context?.close();await browser?.close();});
