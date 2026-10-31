'use strict';
// Compare the previous release with the working tree. Before committing, run
// with BASELINE_REF=HEAD; after committing, the default HEAD^ is the old release.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), scope = '/PoliceTools-PrepaidCard-BatchOCR/';
const baseline = process.env.BASELINE_REF || 'HEAD^', old = new Map();
for (const name of ['index.html','app.js','styles.css','ocr-review.js','sw.js','offline-assets.js']) {
  old.set(name,execFileSync('git',['show',`${baseline}:docs/${name}`],{cwd:root}));
}
const version = bytes => String(bytes).match(/OFFLINE_APP_VERSION='([^']+)'/)[1];
const previousVersion = version(old.get('offline-assets.js'));
const mime = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm'};
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
  const currentVersion = version(await fs.readFile(path.join(root,'docs/offline-assets.js')));
  assert.notEqual(previousVersion,currentVersion,'Choose a baseline before the version bump');
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  browser = await chromium.launch({headless:true,...(process.env.CHROME_BIN ? {executablePath:process.env.CHROME_BIN} : {})});
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}${scope}`;
  await page.goto(url); await page.evaluate(()=>offlineOCRTest.waitForCache());
  assert.equal(await page.evaluate(()=>offlineOCRTest.getState().version),previousVersion);
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
  assert(await page.evaluate(()=>Array.from('O0Ii1lＯ０Ｉｉ１ｌ').every(text=>OfflineOCRReview.analyze({best:{text,charConfidence:[1]}}).needsReview)));
  assert(await page.evaluate(()=>Array.from('oLｏＬ').every(text=>!OfflineOCRReview.analyze({best:{text,charConfidence:[1]}}).needsReview)));
  const result = await page.evaluate(async()=>{
    const cache = await caches.open(offlineOCRTest.getState().cacheName);
    const files = await Promise.all(['ocr-review.js','review-guide.html','review-guide.css'].map(async name=>Boolean(await cache.match(new URL(name,location.href).href))));
    return {files,keys:await caches.keys()};
  });
  assert(result.files.every(Boolean));
  assert(result.keys.includes('offline-serial-ocr:%2Fother-project%2F:v8.4'));
  assert(result.keys.includes('offline-serial-ocr-v7-legacy'));
  await page.goto(url+'review-guide.html');
  assert.equal(await page.locator('.brand-finding').count(),7);
  assert.match(await page.locator('.guide-rules').textContent(),/小寫 o 與大寫 L 不列入此項提醒/);
  assert.deepEqual(errors,[]);
  const report = {status:'pass',from:previousVersion,to:currentVersion,browser:browser.version(),finished_utc:new Date().toISOString(),
    checks:['Previous release loads from its offline cache','New service worker activates and removes only the old project cache','Other project and legacy caches are preserved','Offline reload uses the new ambiguity rules','Guide HTML and CSS are cached and open offline'],uncaught_errors:errors};
  if (process.env.REPORT_PATH) await fs.writeFile(process.env.REPORT_PATH,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
})().catch(error=>{ console.error(error); process.exitCode=1; }).finally(async()=>{ await browser?.close(); server.close(); });
