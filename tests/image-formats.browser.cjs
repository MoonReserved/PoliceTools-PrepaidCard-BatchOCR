'use strict';
// Real synthetic encoded fixtures, actual browser codecs and OCR; no uploaded data.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../docs'),fixtures=path.join(__dirname,'fixtures/images');
const csp=require('node:fs').readFileSync(path.join(root,'index.html'),'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm'};
const checks=[],errors=[],external=[],writes=[];let browser;
const server=http.createServer(async(req,res)=>{
  try{
    const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html',target=path.resolve(root,name);
    if(!target.startsWith(root+path.sep))return res.writeHead(403).end();
    const bytes=await fs.readFile(target);
    // Native launchers also send CSP on worker responses, not just the HTML page.
    res.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream','Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff'}).end(bytes);
  }catch{res.writeHead(404).end();}
});
function pass(name){checks.push(name);console.log('PASS',name);}
async function payload(name,alias=name,type=''){return {name:alias,type,bytes:[...await fs.readFile(path.join(fixtures,name))]};}
(async()=>{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
  const context=await browser.newContext(),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  context.on('request',req=>{if(/^https?:/.test(req.url())&&!req.url().startsWith(origin+'/'))external.push(req.url());if(!['GET','HEAD'].includes(req.method()))writes.push(req.method()+' '+req.url());});
  await page.goto(origin);await page.evaluate(()=>offlineOCRTest.waitForCache());
  await page.evaluate(()=>{
    window.testFile=p=>new File([new Uint8Array(p.bytes)],p.name,{type:p.type});
    window.samples=async blob=>{
      const b=await OfflineImage.decode(blob),c=document.createElement('canvas');c.width=b.width;c.height=b.height;
      const ctx=c.getContext('2d');ctx.drawImage(b,0,0);b.close();
      return {size:[c.width,c.height],colours:[[25,25],[c.width-25,25],[25,c.height-25]].map(([x,y])=>[...ctx.getImageData(x,y,1,1).data])};
    };
  });
  const colourOK=result=>{
    assert.deepEqual(result.size,[900,500]);
    const [r,g,b]=result.colours;
    assert(r[0]>150&&r[1]<80&&r[2]<80,JSON.stringify(result));
    assert(g[1]>120&&g[0]<80&&g[2]<80,JSON.stringify(result));
    assert(b[2]>150&&b[0]<80&&b[1]<100,JSON.stringify(result));
  };
  for(const name of ['serial.heic','serial-10bit.heic','primary.heic',...Array.from({length:7},(_,i)=>`orientation-${i+2}.heic`),
    'rgb.tif','cmyk.tif','tiff_adobe_deflate.tif','packbits.tif','jpeg.tif',...Array.from({length:7},(_,i)=>`orientation-${i+2}.tif`)]){
    const result=await page.evaluate(async p=>{const file=testFile(p),converted=await OfflineImage.prepare(file,await OfflineImage.identify(file));return {sample:await samples(converted.pages[0]),notice:converted.notice,count:converted.pages.length};},await payload(name));
    colourOK(result.sample);assert.equal(result.count,1);
    if(name==='primary.heic')assert.match(result.notice,/主要照片/);
    pass(name+': full resolution, orientation and colour markers');
  }
  for(const name of ['gray.tif','fax4.tif']){
    const result=await page.evaluate(async p=>{const file=testFile(p),converted=await OfflineImage.prepare(file,await OfflineImage.identify(file));return samples(converted.pages[0]);},await payload(name));
    assert.deepEqual(result.size,[900,500]);pass(name+': grayscale/fax decoding');
  }
  for(const [name,alias,type] of [['serial.png','extensionless',''],['serial.heic','PHONE.HEIF','application/octet-stream'],['serial.heic','wrong.jpg','image/jpeg'],['rgb.tif','SCAN.TIFF',''],['serial.avif','photo.avif','image/avif'],['serial.bmp','photo.bmp','image/bmp'],['serial.gif','photo.gif','image/gif']]){
    const result=await page.evaluate(async p=>{const file=testFile(p),converted=await OfflineImage.prepare(file,await OfflineImage.identify(file));return samples(converted.pages[0]);},await payload(name,alias,type));
    colourOK(result);pass(alias+': accepted with expected pixels');
  }
  const native=await page.evaluate(async()=>{
    const c=document.createElement('canvas');c.width=900;c.height=500;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,900,500);
    const results=[];
    for(const type of ['image/jpeg','image/webp']){const blob=await new Promise(resolve=>c.toBlob(resolve,type));const file=new File([blob],'photo.'+(type==='image/jpeg'?'JFIF':'webp'),{type:''});await OfflineImage.prepare(file,await OfflineImage.identify(file));results.push(blob.type);}
    const svg=new File(['<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500"><rect width="900" height="500" fill="white"/></svg>'],'vector.svg',{type:'image/svg+xml'});
    await OfflineImage.prepare(svg,await OfflineImage.identify(svg));return results;
  });
  assert.deepEqual(native,['image/jpeg','image/webp']);pass('JPEG/JFIF, WebP and SVG decode');
  const pages=await payload('pages.tiff');
  const tiff=await page.evaluate(async p=>{const f=testFile(p),r=await OfflineImage.prepare(f,'tiff');let error='';try{await OfflineImage.prepare(f,'tiff',{maxPages:1});}catch(e){error=e.code;}return {count:r.pages.length,first:await samples(r.pages[0]),error};},pages);
  assert.equal(tiff.count,2);colourOK(tiff.first);assert.equal(tiff.error,'PAGE_LIMIT');pass('Multipage TIFF and page limit before pixel allocation');
  // Real UI import, detector, original-resolution recognition, rotation/retry and export.
  await page.locator('#image').setInputFiles(['serial.heic','pages.tiff'].map(name=>path.join(fixtures,name)));
  let s=await page.evaluate(()=>offlineOCRTest.whenIdle());
  assert.equal(s.files.length,3);assert(s.files.every(f=>f.status==='ready'&&f.boxes.length));
  assert.equal(await page.locator('.file-page').nth(1).textContent(),'TIFF 第 1／2 頁');
  for(const f of s.files.slice(0,2)){
    await page.evaluate(async id=>{await offlineOCRTest.navigate(id);await offlineOCRTest.whenIdle();},f.id);
    const id=await page.evaluate(()=>{const b=currentFile().boxes.find(b=>b.box[1]>150&&b.box[1]<300);if(!b)throw Error('Missing serial box');selectBox(currentFile().id,b.id);return b.id;});
    await page.evaluate(()=>offlineOCRTest.whenIdle());
    assert.match(await page.evaluate(id=>findBox(state.currentId,id).result.results[0].best.text,id),/12345678901234/);
    await page.evaluate(async()=>{await offlineOCRTest.rotateFile(state.currentId,1);await offlineOCRTest.whenIdle();});
    await page.locator(`[data-result-id="${id}"]`).getByRole('button',{name:'重試',exact:true}).click();await page.evaluate(()=>offlineOCRTest.whenIdle());
    assert.match(await page.evaluate(()=>offlineOCRTest.exportTXT()),/12345678901234/);
    pass(f.sourceName+': actual OCR, rotation, saved crop retry and clean export');
  }
  await page.evaluate(()=>offlineOCRTest.clear());
  const damaged=await payload('serial.heic');damaged.bytes=damaged.bytes.slice(0,48);
  const badTIFF=await payload('rgb.tif');badTIFF.bytes=badTIFF.bytes.slice(0,100);
  const mixed=await page.evaluate(async inputs=>{
    await offlineOCRTest.addFiles(inputs.map(testFile));await offlineOCRTest.whenIdle();return {count:state.files.length,warning:document.getElementById('import-warning').textContent};
  },[damaged,badTIFF,{name:'camera.DNG',type:'image/dng',bytes:[1,2,3]},await payload('serial.png')]);
  assert.equal(mixed.count,1);assert.match(mixed.warning,/3 個檔案未加入/);assert.match(mixed.warning,/RAW/);pass('Damaged HEIC/TIFF and RAW rejected while good files continue');
  await page.evaluate(()=>offlineOCRTest.clear());
  // Keep 199 tiny native pages paused, then atomically reject an overflowing TIFF batch.
  const limit=await page.evaluate(async p=>{
    offlineOCRTest.pause();const c=document.createElement('canvas');c.width=c.height=1;const blob=await new Promise(r=>c.toBlob(r));
    await offlineOCRTest.addFiles(Array.from({length:199},(_,i)=>new File([blob],i+'.png',{type:'image/png'})));
    await offlineOCRTest.addFiles([new File([blob],'not-committed.png'),testFile(p)]);
    return {count:state.files.length,warning:$('import-warning').textContent};
  },pages);
  assert.equal(limit.count,199);assert.match(limit.warning,/沒有加入任何新檔案/);pass('200-page cap remains atomic with TIFF and existing queue');
  await page.evaluate(()=>offlineOCRTest.clear());
  const white=await page.evaluate(async()=>{
    const c=document.createElement('canvas');c.width=900;c.height=500;const ctx=c.getContext('2d');ctx.fillStyle='#000';ctx.font='bold 48px Arial';ctx.fillText('12345678901234',140,240);
    const blob=await new Promise(r=>c.toBlob(r));await offlineOCRTest.addFiles([new File([blob],'transparent.png',{type:'image/png'})]);await offlineOCRTest.whenIdle();
    const f=currentFile(),crop=await originalCrop(f,{polygon:[[0,0],[900,0],[900,500],[0,500]]});
    ctx.clearRect(0,0,900,500);ctx.drawImage(crop.bitmap,0,0);crop.bitmap.close();return [...ctx.getImageData(0,0,1,1).data];
  });
  assert.deepEqual(white,[255,255,255,255]);pass('Transparent PNG original-resolution OCR crop uses a white background');
  await page.evaluate(()=>offlineOCRTest.clear());
  // Cancellation terminates an in-flight codec and the next batch can still import.
  const cancelled=await page.evaluate(async p=>{
    const NativeWorker=window.Worker;let started;const ready=new Promise(r=>started=r);
    window.Worker=class extends NativeWorker{constructor(url,...args){super(url,...args);if(String(url).includes('image-decoder'))started();}};
    try{const pending=offlineOCRTest.addFiles([testFile(p)]);await ready;await offlineOCRTest.clear();await pending;return state.files.length;}finally{window.Worker=NativeWorker;}
  },await payload('serial.heic'));
  assert.equal(cancelled,0);pass('Clear during HEIC conversion does not restore removed data');
  await context.setOffline(true);await page.reload();await page.evaluate(()=>offlineOCRTest.waitForCache());
  await page.locator('#image').setInputFiles(['serial.heic','pages.tiff'].map(name=>path.join(fixtures,name)));
  s=await page.evaluate(()=>offlineOCRTest.whenIdle());assert.equal(s.files.length,3);assert(s.files.every(f=>f.status==='ready'&&f.boxes.length));
  await page.evaluate(()=>offlineOCRTest.selectBox(state.files[0].id,state.files[0].boxes.find(b=>b.box[1]>150).id));await page.evaluate(()=>offlineOCRTest.whenIdle());
  assert.match(await page.evaluate(()=>offlineOCRTest.exportTXT()),/12345678901234/);pass('Offline reload, new HEIC/TIFF imports and actual OCR');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(writes,[]);pass('No uncaught errors, external requests or uploads');
  const report={status:'pass',release:'v8.6',browser:browser.version(),finished_utc:new Date().toISOString(),passed:checks.length,checks,uncaught_errors:errors,external_requests:external,http_write_requests:writes};
  if(process.env.REPORT_PATH)await fs.writeFile(process.env.REPORT_PATH,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.close();});
