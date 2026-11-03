'use strict';
// Compare the previous app version with the working tree. BASELINE_REF can
// explicitly select an older release. Retired codec bytes are not needed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), scope = '/PoliceTools-PrepaidCard-BatchOCR/';
const version = bytes => String(bytes).match(/OFFLINE_APP_VERSION='([^']+)'/)[1];
const currentVersion = version(require('node:fs').readFileSync(path.join(root,'docs/offline-assets.js')));
let baseline = process.env.BASELINE_REF || 'HEAD';
while(!process.env.BASELINE_REF && version(execFileSync('git',['show',`${baseline}:docs/offline-assets.js`],{cwd:root}))===currentVersion)baseline+='^';
const old = new Map();
const retired=['image-codecs/libheif-bundle.js','sources/image-codecs-source.zip','licenses/LIBHEIF_LICENSE.txt','licenses/LIBDE265_LICENSE.txt'];
const oldManifest=execFileSync('git',['show',`${baseline}:docs/offline-assets.js`],{cwd:root});
const oldGlobals={};require('node:vm').runInNewContext(String(oldManifest),oldGlobals);
for (const name of new Set(oldGlobals.OFFLINE_ASSETS.map(name=>name==='./'?'index.html':name))) {
  // A cache-removal test only needs a marker at a retired URL. Never recover,
  // execute or republish the old HEVC implementation to test this migration.
  old.set(name,retired.includes(name)?Buffer.from('Retired resource cache test marker'):execFileSync('git',['show',`${baseline}:docs/${name}`],{cwd:root,maxBuffer:100*1024*1024}));
}
const previousVersion = version(old.get('offline-assets.js'));
const mime = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.txt':'text/plain; charset=utf-8','.wasm':'application/wasm'};
let latest = false, browser;
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    if (!url.pathname.startsWith(scope)) return res.writeHead(404).end();
    const name = url.pathname.slice(scope.length) || 'index.html', target = path.resolve(root,'docs',name);
    if (!target.startsWith(path.join(root,'docs')+path.sep)) return res.writeHead(403).end();
    res.setHeader('Content-Type',mime[path.extname(name)] || 'application/octet-stream');
    res.setHeader('Cache-Control','no-cache');
    res.end(!latest && old.has(name) ? old.get(name) : await fs.readFile(target));
  } catch { res.writeHead(404).end(); }
});
(async () => {
  assert.notEqual(previousVersion,currentVersion,'Choose a baseline before the version bump');
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  browser = await chromium.launch({headless:true,...(process.env.CHROME_BIN ? {executablePath:process.env.CHROME_BIN} : {})});
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}${scope}`;
  await page.goto(url); await page.evaluate(()=>offlineOCRTest.waitForCache());
  assert.equal(await page.evaluate(()=>offlineOCRTest.getState().version),previousVersion);
  await page.evaluate(async paths=>{const c=await caches.open(offlineOCRTest.getState().cacheName);for(const p of paths)if(!await c.match(new URL(p,location.href)))await c.put(new URL(p,location.href),new Response('Retired resource cache test marker'));},retired);
  assert(await page.evaluate(async paths=>{const c=await caches.open(offlineOCRTest.getState().cacheName);return (await Promise.all(paths.map(p=>c.match(new URL(p,location.href))))).every(Boolean);},retired));
  if(previousVersion==='v8.6')assert(await page.evaluate(()=>Array.from('iｉ').every(text=>OfflineOCRReview.analyze({best:{text,charConfidence:[1]}}).needsReview)));
  await page.evaluate(async()=>{
    await caches.open('offline-serial-ocr:%2Fother-project%2F:v8.4');
    await caches.open('offline-serial-ocr-v7-legacy');
  });
  latest = true;
  await page.evaluate(async()=>{
    const changed = new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
    await (await navigator.serviceWorker.getRegistration()).update(); await changed;
  });
  await page.waitForFunction(async ({previousVersion,currentVersion})=>{
    const prefix='offline-serial-ocr:'+encodeURIComponent(location.pathname)+':',keys=await caches.keys();
    return keys.includes(prefix+currentVersion)&&!keys.includes(prefix+previousVersion);
  },{previousVersion,currentVersion});
  await page.reload(); await page.evaluate(()=>offlineOCRTest.waitForCache());
  assert.equal(await page.evaluate(()=>offlineOCRTest.getState().version),currentVersion);
  await context.setOffline(true);
  await page.reload(); await page.evaluate(()=>offlineOCRTest.waitForCache());
  assert(await page.evaluate(()=>Array.from('O0I1lＯ０Ｉ１ｌ').every(text=>OfflineOCRReview.analyze({best:{text,charConfidence:[1]}}).needsReview)));
  assert(await page.evaluate(()=>Array.from('ioLｉｏＬ').every(text=>!OfflineOCRReview.analyze({best:{text,charConfidence:[1]}}).needsReview)));
  const result = await page.evaluate(async()=>{
    const cache = await caches.open(offlineOCRTest.getState().cacheName);
    const files = await Promise.all(['ocr-review.js','review-guide.html','review-guide.css','image-source.js','image-decoder-worker.js','image-codecs/UTIF.js','licenses/IMAGE_CODECS.txt','licenses/THIRD_PARTY_NOTICES.txt','licenses/NOTO_FONT_OFL.txt'].map(async name=>Boolean(await cache.match(new URL(name,location.href).href))));
    return {files,keys:await caches.keys()};
  });
  assert(result.files.every(Boolean));
  assert(result.keys.includes('offline-serial-ocr:%2Fother-project%2F:v8.4'));
  assert(result.keys.includes('offline-serial-ocr-v7-legacy'));
  assert(await page.evaluate(async paths=>(await Promise.all(paths.map(p=>caches.match(new URL(p,location.href))))).every(v=>!v),retired));
  const message=await page.evaluate(async()=>{
    try{await OfflineImage.prepare(new File(['invalid'],'upgraded.heic'),'heif');return '';}
    catch(e){return e.message;}
  });
  assert.match(message,/授權.*Safari.*JPG／PNG/);
  await page.goto(url+'licenses/THIRD_PARTY_NOTICES.txt');
  assert.match(await page.textContent('body'),/Copyright 2014 Mozilla Foundation/);
  await page.goto(url+'review-guide.html');
  assert.equal(await page.locator('.brand-finding').count(),7);
  assert.match(await page.locator('.guide-rules').textContent(),/小寫 i、o 與大寫 L 不列入此項提醒/);
  assert.deepEqual(errors,[]);
  const report = {status:'pass',from:previousVersion,to:currentVersion,browser:browser.version(),retired_resource_bytes:'inert test markers',finished_utc:new Date().toISOString(),
    checks:['Previous release loads with inert markers at retired HEVC asset URLs','New service worker activates and removes the old project cache and HEVC assets','Other project and legacy caches are preserved','Offline reload preserves ambiguity rules','TIFF and notices are cached; unsupported HEIC shows guidance offline','Supplemental copyright notices open offline','Guide HTML and CSS are cached and open offline'],uncaught_errors:errors};
  if (process.env.REPORT_PATH) await fs.writeFile(process.env.REPORT_PATH,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
})().catch(error=>{ console.error(error); process.exitCode=1; }).finally(async()=>{ await browser?.close(); server.close(); });
