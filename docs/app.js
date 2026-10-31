'use strict';
// Files stay local. PDF pages share their source File; rendering and image decoding are serialized.
const $=id=>document.getElementById(id);
const FILE_MODE=location.protocol==='file:';
$('local-file-help').hidden=!FILE_MODE;
if(FILE_MODE){$('image').disabled=true;$('status').textContent='請先使用 macOS 或 Windows 啟動工具，再從本機網址加入檔案。';}
const MAX_FILES=200,WORKING_SIDE=2560,APP_VERSION=globalThis.OFFLINE_APP_VERSION;
const CACHE_NAME='offline-serial-ocr:'+encodeURIComponent(new URL('./',location.href).pathname)+':'+APP_VERSION;
const mobile=matchMedia('(pointer:coarse)').matches||/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const recommended=(navigator.deviceMemory&&navigator.deviceMemory<=2)?10:(mobile?20:100);
const state={files:[],selectionOrder:[],currentId:null,display:null,displayId:null,navigationToken:0,epoch:0,nextId:0,worker:null,request:0,pending:new Map(),detectQueue:[],ocrQueue:[],pumping:false,active:null,paused:false,cacheReady:false,manual:false,drag:null,importPending:0,importLabel:'',metrics:{activeWorkerRequests:0,maxActiveWorkerRequests:0,detectStarted:0,recognizeStarted:0,completedJobs:0},history:[]};
const fileNodes=new Map(),resultNodes=new Map();
let decodeChain=Promise.resolve();
let importChain=Promise.resolve();
let candidateObserver=null,candidateRender=0;
const source=$('source');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const findFile=id=>state.files.find(f=>f.id===id);
const currentFile=()=>findFile(state.currentId);
const visibleBoxes=file=>file.boxes.filter(box=>!box.retired);
const angleText=angle=>String(angle>180?Math.round((angle-360)*1000000)/1000000:angle);
const findBox=(fileId,boxId)=>findFile(fileId)?.boxes.find(b=>b.id===boxId);
const withDecode=fn=>{const task=decodeChain.then(fn,fn);decodeChain=task.catch(()=>{});return task;};
const node=(tag,className,text)=>{const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;};
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
// A single ordered selection list drives cards, clipboard, TXT and CSV.
// Never derive output order from file order, detected box number or OCR completion.
function selectedRows(){
  const selected=new Map();
  for(const file of state.files)for(const box of file.boxes)if(box.selected)selected.set(box.id,{file,box});
  return state.selectionOrder.map(id=>selected.get(id)).filter(Boolean).map((row,index)=>({...row,order:index+1}));
}
function exportRows(){return selectedRows().filter(({box})=>box.result&&box.status==='done'&&(!$('verified-only').checked||box.verified));}
function currentIndex(){return state.files.findIndex(f=>f.id===state.currentId);}
function warning(text){$('import-warning').textContent=text;$('import-warning').hidden=!text;}
$('batch-hint').textContent=`這台裝置建議先以 ${recommended} 張／頁為一批；手機通常 10–20、桌機 100。每張圖片或每頁 PDF 各算 1 個，單批上限 ${MAX_FILES}。實際負荷也取決於檔案內容，並非保證安全數量。`;

function updateSummary(){
  const selected=selectedRows(),done=selected.filter(x=>x.box.status==='done').length,failed=selected.filter(x=>x.box.status==='error').length;
  const scanned=state.files.filter(f=>f.status==='ready'||f.status==='error').length;
  $('batch-summary').textContent=state.files.length?`${state.files.length} 張／頁 · 已掃描 ${scanned} · 已選 ${selected.length} 框 · 完成 ${done}${failed?' · 失敗 '+failed:''}`:'尚未加入圖片或 PDF';
  $('batch-progress').max=Math.max(1,state.files.length);$('batch-progress').value=scanned;
  $('file-count').textContent=`${state.files.length} 張／頁`;$('selected-count').textContent=`${selected.length} 個已選框`;
  $('clear').disabled=!state.files.length&&!state.importPending;
  $('image').disabled=FILE_MODE||state.importPending>0;
  $('import-status').hidden=!state.importPending;
  $('import-status').textContent=state.importPending?(state.importLabel||'正在準備匯入…'):'';
  $('pause').disabled=!state.files.length;$('pause').textContent=state.paused?'繼續背景掃描':'暫停背景掃描';
  const file=currentFile(),index=currentIndex();
  $('previous').disabled=index<=0;$('next').disabled=index<0||index>=state.files.length-1;
  $('image-position').textContent=`${index<0?0:index+1} / ${state.files.length}`;
  $('remove-image').disabled=!file;$('more-boxes').disabled=!file||file.rotating||file.status==='detecting'||state.detectQueue.some(j=>j.fileId===file.id&&j.mode==='detail');
  $('manual').disabled=!file||file.rotating||state.displayId!==file.id;
  const rotationBusy=!file||file.rotating||state.displayId!==file.id||state.active?.fileId===file.id;
  $('rotate-left').disabled=$('rotate-right').disabled=$('rotation-angle').disabled=$('apply-rotation').disabled=rotationBusy;
  const angle=$('rotation-angle'),angleFile=file?.id||'',angleValue=String(file?.rotation||0);
  if(angle.dataset.fileId!==angleFile||angle.dataset.rotation!==angleValue){angle.value=angleText(file?.rotation||0);angle.dataset.fileId=angleFile;angle.dataset.rotation=angleValue;}
  $('rotation-status').textContent=!file?'尚未選擇頁面':file.rotating?'正在旋轉…':`目前方向：${angleText(file.rotation)}°${state.active?.fileId===file.id?' · 處理中':''}`;
  $('manual').textContent=state.manual?'取消手動補框':'啟用手動補框';
  const rows=exportRows(),pending=selected.filter(x=>x.box.status!=='done'&&x.box.status!=='error').length;
  $('export-summary').textContent=`可輸出 ${rows.length} 筆${pending?' · '+pending+' 筆尚在處理':''}${failed?' · '+failed+' 筆失敗，請重試':''}`;
  for(const id of ['copy-all','export-txt','export-csv'])$(id).disabled=!rows.length;
}
function fileStateText(file){
  const selected=file.boxes.filter(b=>b.selected),done=selected.filter(b=>b.status==='done').length;
  if(file.status==='error')return '掃描失敗，可重試';
  if(file.status==='detecting')return file.mode==='detail'?'正在找更多框…':'正在找文字位置…';
  if(file.status==='waiting')return state.paused?'等待掃描（已暫停）':'等待掃描';
  return `${visibleBoxes(file).length} 候選 · 選 ${selected.length} · 完成 ${done}`;
}
function renderFiles(){
  const list=$('file-list');
  if(!state.files.length){list.replaceChildren(node('p','empty-note','圖片與 PDF 的每一頁會列在這裡。'));fileNodes.clear();return;}
  for(const child of [...list.children])if(!child.dataset.fileId)child.remove();
  for(const [id,el]of fileNodes)if(!findFile(id)){el.remove();fileNodes.delete(id);}
  state.files.forEach((file,index)=>{
    let row=fileNodes.get(file.id);
    if(!row){
      row=node('div','file-row');row.dataset.fileId=file.id;
      const open=node('button','file-item');open.type='button';open.dataset.fileId=file.id;
      open.append(node('span','file-thumb file-placeholder',String(index+1)));
      const info=node('span','file-information'),heading=node('span','file-heading');heading.append(node('span','file-order'),node('span','file-name',file.sourceName||file.name));
      const page=node('span','file-page',file.kind==='pdf'?`PDF 第 ${file.pdfPage}／${file.pdfPageCount} 頁`:'圖片');
      info.append(heading,page,node('span','file-state'));open.append(info);open.title=file.name;
      open.addEventListener('click',()=>navigate(file.id).catch(e=>status(e.message,true)));
      const controls=node('div','page-order-controls'),up=node('button','subtle page-move-up','↑'),down=node('button','subtle page-move-down','↓');
      up.type=down.type='button';up.title='往前一張／頁';down.title='往後一張／頁';
      up.setAttribute('aria-label',`將 ${file.name} 往前移`);down.setAttribute('aria-label',`將 ${file.name} 往後移`);
      up.addEventListener('click',()=>moveFile(file.id,-1));down.addEventListener('click',()=>moveFile(file.id,1));
      controls.append(up,down);row.append(open,controls);fileNodes.set(file.id,row);
    }
    const open=row.querySelector('.file-item');row.classList.toggle('active',file.id===state.currentId);open.classList.toggle('active',file.id===state.currentId);open.setAttribute('aria-current',file.id===state.currentId?'true':'false');
    row.dataset.order=String(index+1);row.querySelector('.file-order').textContent=String(index+1);
    row.querySelector('.page-move-up').disabled=index===0;row.querySelector('.page-move-down').disabled=index===state.files.length-1;
    const detail=row.querySelector('.file-state');detail.textContent=fileStateText(file);detail.classList.toggle('problem',file.status==='error');
    if(file.thumbnailURL&&row.dataset.thumbnail!==file.thumbnailURL){const img=node('img','file-thumb');img.src=file.thumbnailURL;img.alt='';img.loading='lazy';img.decoding='async';open.firstElementChild.replaceWith(img);row.dataset.thumbnail=file.thumbnailURL;}
    else if(!file.thumbnailURL)open.firstElementChild.textContent=String(index+1);
    if(list.children[index]!==row)list.insertBefore(row,list.children[index]||null);
  });
}
function moveFile(fileId,direction){
  if(direction!==-1&&direction!==1)throw Error('頁面排序方向必須是上移或下移。');
  const index=state.files.findIndex(file=>file.id===fileId),next=index+direction;
  if(index<0||next<0||next>=state.files.length)return false;
  [state.files[index],state.files[next]]=[state.files[next],state.files[index]];
  const position=new Map(state.files.map((file,i)=>[file.id,i]));
  // Keep explicit rescans ahead of background work; never interrupt the active job.
  state.detectQueue.sort((a,b)=>Number(!!b.explicit)-Number(!!a.explicit)||(position.get(a.fileId)??Infinity)-(position.get(b.fileId)??Infinity));
  renderFiles();updateSummary();status(`頁面已移至第 ${next+1} 個位置；序號輸出仍保留目前的點選排序。`);
  return true;
}
function pointInPolygon(x,y,polygon){let inside=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const [xi,yi]=polygon[i],[xj,yj]=polygon[j];if(((yi>y)!==(yj>y))&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;}return inside;}
function draw(){
  const file=currentFile();
  if(!file||!state.display||state.displayId!==file.id){source.hidden=true;source.style.display='none';$('empty-image').hidden=false;return;}
  source.hidden=false;source.style.display='block';$('empty-image').hidden=true;
  const scale=Math.min(1,1400/state.display.width),w=Math.round(state.display.width*scale),h=Math.round(state.display.height*scale);
  if(source.width!==w||source.height!==h){source.width=w;source.height=h;}
  const ctx=source.getContext('2d');ctx.clearRect(0,0,w,h);ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(state.display,0,0,w,h);
  for(const box of visibleBoxes(file)){const polygon=box.polygon;ctx.beginPath();polygon.forEach(([x,y],i)=>i?ctx.lineTo(x*scale,y*scale):ctx.moveTo(x*scale,y*scale));ctx.closePath();ctx.fillStyle=box.selected?'#16835b25':'#cf7b1008';ctx.fill();ctx.strokeStyle=box.selected?'#087b4f':'#d5750d';ctx.lineWidth=box.selected?3:1.5;ctx.stroke();const lx=Math.max(0,box.box[0]*scale),ly=Math.max(0,box.box[1]*scale-17);ctx.fillStyle=box.selected?'#087b4f':'#a65c08';ctx.fillRect(lx,ly,Math.max(21,String(box.number).length*8+8),17);ctx.font='12px sans-serif';ctx.fillStyle='#fff';ctx.fillText(String(box.number),lx+4,ly+12);}
  if(state.drag&&state.manual){const [x,y,w0,h0]=state.drag.box;ctx.setLineDash([5,3]);ctx.strokeStyle='#1d65bd';ctx.lineWidth=2;ctx.strokeRect(x*scale,y*scale,w0*scale,h0*scale);ctx.setLineDash([]);}
  source.classList.toggle('manual',state.manual);
}
function cropCanvas(bitmap,box,maxW=520,maxH=100,rotate=false){
  const [x,y,w,h]=box,scale=Math.min(maxW/w,maxH/h,2),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);if(rotate){ctx.translate(canvas.width,canvas.height);ctx.rotate(Math.PI);}ctx.drawImage(bitmap,x,y,w,h,0,0,canvas.width,canvas.height);return canvas;
}
function canvasBlob(canvas,type='image/png'){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('無法建立本機預覽。')),type,.82));}
async function rotateBitmap(bitmap,rotation){
  const view=PageRotation.geometry(bitmap.width,bitmap.height,rotation,WORKING_SIDE),canvas=document.createElement('canvas');
  canvas.width=view.width;canvas.height=view.height;
  try{
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.setTransform(...view.matrix);ctx.drawImage(bitmap,0,0);return await createImageBitmap(canvas);
  }finally{canvas.width=canvas.height=0;}
}
function rotateFile(fileId,direction){
  if(direction!==-1&&direction!==1)throw Error('旋轉方向必須是向左或向右。');
  const file=findFile(fileId);return file?rotateTo(fileId,(file.rotation+direction*90+360)%360):Promise.resolve(false);
}
async function rotateTo(fileId,angle){
  const rotation=PageRotation.normalize(angle),file=findFile(fileId);
  if(!file||file.rotating||state.active?.fileId===fileId||state.displayId!==fileId)return false;
  if(rotation===file.rotation){status('目前已是此角度；需要補掃時可按「找更多候選框」。');return false;}
  const epoch=state.epoch;
  file.rotating=true;state.manual=false;state.drag=null;updateSummary();draw();
  const task=(async()=>{
    let prepared;
    try{
      // Always render from the source, never resample the last rotated preview.
      prepared=await loadPageView(file,rotation,epoch);
      const bitmap=prepared.bitmap,blob=await canvasBlob(cropCanvas(bitmap,[0,0,bitmap.width,bitmap.height],130,160),'image/jpeg');
      if(epoch!==state.epoch||!findFile(fileId))return false;
      // Remove every old overlay. Selected results keep their own immutable view
      // for exports and retries, but never rejoin the new candidate scan.
      file.boxes=file.boxes.filter(box=>{
        if(box.selected){if(!box.retired)box.pageView={...file.view,matrix:file.view.matrix.slice()};box.retired=true;return true;}
        if(box.previewURL)URL.revokeObjectURL(box.previewURL);return false;
      });
      applyPageView(file,prepared);
      if(file.thumbnailURL)URL.revokeObjectURL(file.thumbnailURL);
      file.thumbnailURL=URL.createObjectURL(blob);file.status='waiting';file.error='';file.warningLog=[];file.lastDetection=null;
      if(state.currentId===fileId){state.navigationToken++;state.display?.close();state.display=bitmap;state.displayId=fileId;prepared=null;}
      state.detectQueue=state.detectQueue.filter(job=>job.fileId!==fileId);
      state.detectQueue.unshift({type:'detect',fileId,mode:'default',explicit:true});
      status(`方向已調整為 ${angleText(rotation)}°，舊框已清除，正在重新掃描；已選序號保留在結果清單。`);
      return true;
    }catch(error){if(epoch!==state.epoch||!findFile(fileId))return false;throw error;}
    finally{
      prepared?.bitmap.close();file.rotating=false;file.rotationTask=null;
      if(epoch===state.epoch){renderFiles();renderResults();renderCurrent();pump();}
    }
  })();
  file.rotationTask=task;return task;
}
function renderCandidates(){
  const file=currentFile(),boxes=file?visibleBoxes(file):[],list=$('candidate-list'),scroll=list.scrollTop,generation=++candidateRender;
  candidateObserver?.disconnect();candidateObserver=null;list.replaceChildren();
  $('candidate-count').textContent=file?`${boxes.length} 個候選`:'尚未掃描';
  if(!file||!boxes.length){list.append(node('p','empty-note',file?.status==='error'?`掃描失敗：${file.error}。可按「找更多候選框」重試。`:file?.status==='ready'?'尚未找到文字，可按「找更多候選框」。':'模型正在尋找位置；完成後，直接點選需要的行。'));return;}
  const paint=button=>{if(generation!==candidateRender||!button.isConnected||button.dataset.painted||!state.display||state.displayId!==file.id)return;const box=file.boxes.find(b=>b.id===button.dataset.boxId);if(!box)return;const canvas=cropCanvas(state.display,box.box,520,92);canvas.className='candidate-crop';button.lastElementChild.replaceWith(canvas);button.dataset.painted='true';};
  if('IntersectionObserver'in window)candidateObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){paint(entry.target);candidateObserver?.unobserve(entry.target);}},{root:list,rootMargin:'120px'});
  for(const box of boxes){const button=node('button','candidate-button'+(box.selected?' selected':''));button.type='button';button.dataset.boxId=box.id;button.setAttribute('aria-pressed',String(box.selected));button.setAttribute('aria-label',`候選 ${box.number}${box.selected?'，已選取':''}`);button.append(node('span','candidate-number',box.selected?'✓':String(box.number)),node('span','candidate-crop hint','候選圖片準備中…'));button.addEventListener('click',()=>selectBox(file.id,box.id));list.append(button);candidateObserver?.observe(button);}
  list.scrollTop=scroll;
  if(!candidateObserver){for(const button of [...list.children].slice(0,12))paint(button);list.onscroll=()=>{const bounds=list.getBoundingClientRect();for(const button of list.children){const rect=button.getBoundingClientRect();if(rect.bottom>=bounds.top-120&&rect.top<=bounds.bottom+120)paint(button);}};}
}
function renderCurrent(){
  const file=currentFile();$('image-name').textContent=file?.name||'尚未選擇頁面';
  if(file){$('image-meta').textContent=file.status==='error'?`掃描失敗：${file.error}`:file.status==='detecting'?'正在掃描此頁；其他已找到的框仍可點選。':file.originalWidth?`${file.kind==='pdf'?'PDF 預覽 · ':''}${file.width} × ${file.height} 像素預覽 · ${visibleBoxes(file).length} 個候選 · 點選一行即可開始精讀`:'頁面排隊中，會自動找出候選文字行。';}
  else $('image-meta').textContent='候選框採寬鬆偵測，其他文字也可能被框到。只需點選你要的行。';
  const warnings=(file?.warningLog||[]).flatMap(entry=>(entry.warnings||[]).filter(text=>!visibleBoxes(file).length||!text.startsWith('尚未找到')).map(text=>`${entry.mode==='detail'?'更多候選掃描':'初次掃描'}：${text}`));
  $('image-warning').textContent=[...new Set(warnings)].join('\n');$('image-warning').hidden=!warnings.length;
  draw();renderCandidates();updateSummary();
}
async function loadPageView(file,rotation,epoch=state.epoch){
  return withDecode(async()=>{
    const cancelled=()=>epoch!==state.epoch||!findFile(file.id);
    if(cancelled())throw Error('此頁已移除。');
    let bitmap;
    try{
      bitmap=file.kind==='pdf'?(await OfflinePDF.renderPage(file.pdfSource,file.pdfPage,{maxSide:WORKING_SIDE,isCancelled:cancelled})).bitmap:await createImageBitmap(file.file);
      const originalWidth=bitmap.width,originalHeight=bitmap.height;
      if(originalWidth*originalHeight>80000000)throw Error('圖片超過 8,000 萬像素，請先另存較小版本。');
      const scale=Math.min(1,WORKING_SIDE/Math.max(bitmap.width,bitmap.height));
      if(scale<1){const smaller=await createImageBitmap(bitmap,{resizeWidth:Math.max(1,Math.round(bitmap.width*scale)),resizeHeight:Math.max(1,Math.round(bitmap.height*scale)),resizeQuality:'high'});bitmap.close();bitmap=smaller;}
      const view=PageRotation.geometry(bitmap.width,bitmap.height,rotation,WORKING_SIDE);
      if(rotation){const turned=await rotateBitmap(bitmap,rotation);bitmap.close();bitmap=turned;}
      if(cancelled())throw Error('此頁已移除。');
      const result={bitmap,view,originalWidth,originalHeight};bitmap=null;return result;
    }finally{bitmap?.close();}
  });
}
function applyPageView(file,{view,originalWidth,originalHeight}){
  file.view=view;file.rotation=view.rotation;file.width=view.width;file.height=view.height;
  file.originalWidth=originalWidth;file.originalHeight=originalHeight;
}
async function workingBitmap(file){const prepared=await loadPageView(file,file.rotation);applyPageView(file,prepared);return prepared.bitmap;}
async function updateDisplay(file,bitmap,epoch){
  if(epoch!==state.epoch||state.currentId!==file.id)return;
  const token=state.navigationToken,copy=await createImageBitmap(bitmap);
  if(epoch!==state.epoch||state.currentId!==file.id||token!==state.navigationToken){copy.close();return;}
  state.display?.close();state.display=copy;state.displayId=file.id;renderCurrent();
}
async function navigate(id){
  const file=findFile(id);if(!file)throw Error('找不到圖片。');
  state.currentId=id;state.manual=false;state.drag=null;const token=++state.navigationToken,epoch=state.epoch;
  if(state.displayId!==id){state.display?.close();state.display=null;state.displayId=null;}
  // Move this image ahead of other background detection jobs; selected OCR still wins.
  const queued=state.detectQueue.findIndex(j=>j.fileId===id);if(queued>0)state.detectQueue.unshift(...state.detectQueue.splice(queued,1));
  renderFiles();renderCurrent();
  if(file.rotating){try{await file.rotationTask;}catch(error){if(epoch===state.epoch&&token===state.navigationToken)status('無法旋轉此頁：'+error.message,true);}}
  if(epoch!==state.epoch||token!==state.navigationToken||!findFile(id))return;
  if(!state.display){try{const bitmap=await workingBitmap(file);if(epoch!==state.epoch||token!==state.navigationToken||!findFile(id)){bitmap.close();return;}state.display=bitmap;state.displayId=id;renderCurrent();}catch(error){if(epoch===state.epoch&&token===state.navigationToken)status('無法開啟圖片：'+error.message,true);}}
  pump();
}
function getWorker(){
  if(state.worker)return state.worker;
  const worker=new Worker('ocr-worker.js');state.worker=worker;
  worker.onmessage=({data})=>{
    const request=state.pending.get(data.requestId);if(!request)return;
    if(data.type==='progress'){const active=state.active,file=active&&findFile(active.fileId);if(file){if(active.type==='detect')status(`找文字位置：${file.name}${data.phase==='load-detector'?' · 正在準備偵測模型…':data.index?' · 掃描區域 '+data.index+' / '+data.total:''}`);else status(`精讀選中框：${file.name} · 框 ${findBox(file.id,active.boxId)?.number||''}${data.index?' · '+data.index+'/'+data.total:''}`);}return;}
    state.pending.delete(data.requestId);clearTimeout(request.timeout);state.metrics.activeWorkerRequests--;
    data.type==='done'?request.resolve(data.result):request.reject(Error(data.error||'模型運算失敗。'));
  };
  worker.onerror=error=>{stopWorker(error.message||'模型工作程序意外停止。');};return worker;
}
function stopWorker(reason='工作已取消。'){
  state.worker?.terminate();state.worker=null;
  for(const request of state.pending.values()){clearTimeout(request.timeout);request.reject(Error(reason));}
  state.pending.clear();state.metrics.activeWorkerRequests=0;
}
function callWorker(message,transfer=[]){
  return new Promise((resolve,reject)=>{
    const requestId=++state.request,timeout=setTimeout(()=>stopWorker('單次運算超過 3 分鐘，已釋放模型。請縮小圖片或重試。'),180000);
    state.pending.set(requestId,{resolve,reject,timeout});state.metrics.activeWorkerRequests++;state.metrics.maxActiveWorkerRequests=Math.max(state.metrics.maxActiveWorkerRequests,state.metrics.activeWorkerRequests);
    try{getWorker().postMessage({...message,requestId},transfer);}catch(error){state.pending.delete(requestId);clearTimeout(timeout);state.metrics.activeWorkerRequests--;reject(error);}
  });
}
function validOCRJob(job){const box=findBox(job.fileId,job.boxId);return box&&box.selected&&box.token===job.token;}
function recordJob(job){const entry={type:job.type,fileId:job.fileId,boxId:job.boxId||null,mode:job.mode||null,startedAt:performance.now(),endedAt:null,status:'running'};state.history.push(entry);if(state.history.length>1000)state.history.shift();return entry;}
async function pump(){
  if(state.pumping)return;
  const epoch=state.epoch;state.pumping=true;
  try{
    while(epoch===state.epoch){
      state.ocrQueue=state.ocrQueue.filter(validOCRJob);state.detectQueue=state.detectQueue.filter(j=>findFile(j.fileId));
      const ocrIndex=state.ocrQueue.findIndex(j=>!findFile(j.fileId)?.rotating);
      const detectionIndex=state.detectQueue.findIndex(j=>!findFile(j.fileId)?.rotating&&(!state.paused||j.explicit));
      const job=ocrIndex>=0?state.ocrQueue.splice(ocrIndex,1)[0]:(detectionIndex>=0?state.detectQueue.splice(detectionIndex,1)[0]:null);if(!job)break;
      state.active=job;const entry=recordJob(job);
      try{if(job.type==='detect'){state.metrics.detectStarted++;await detectFile(job,epoch);}else{state.metrics.recognizeStarted++;await recognizeBox(job,epoch);}entry.status='done';}
      catch(error){entry.status='error';entry.error=error.message;if(epoch===state.epoch){const file=findFile(job.fileId);if(job.type==='detect'&&file){file.status='error';file.error=error.message;}else{const box=findBox(job.fileId,job.boxId);if(box&&box.selected&&box.token===job.token){box.status='error';box.error=error.message;}}status('處理失敗：'+error.message,true);}}
      finally{entry.endedAt=performance.now();if(epoch===state.epoch){state.active=null;state.metrics.completedJobs++;renderFiles();renderResults();if(state.currentId===job.fileId)renderCurrent();else updateSummary();}}
      await delay(0);
    }
  }finally{if(epoch===state.epoch){state.pumping=false;state.active=null;updateSummary();if(state.paused&&state.detectQueue.length)status(`背景掃描已暫停，還有 ${state.detectQueue.length} 張待掃描。點選已找到的框仍會辨識。`);else if(!state.detectQueue.length&&!state.ocrQueue.length&&state.files.length)status('佇列已處理完畢。可繼續點選候選框，或核對並匯出結果。');}}
}
function overlap(a,b){const [ax,ay,aw,ah]=a,[bx,by,bw,bh]=b,intersection=Math.max(0,Math.min(ax+aw,bx+bw)-Math.max(ax,bx))*Math.max(0,Math.min(ay+ah,by+bh)-Math.max(ay,by));return intersection/(aw*ah+bw*bh-intersection||1);}
function similarAngle(a,b){const ax=a.polygon[1][0]-a.polygon[0][0],ay=a.polygon[1][1]-a.polygon[0][1],bx=b.polygon[1][0]-b.polygon[0][0],by=b.polygon[1][1]-b.polygon[0][1];return Math.abs(ax*bx+ay*by)/(Math.hypot(ax,ay)*Math.hypot(bx,by)||1)>.995;}
function normalizeBox(raw,file,number){
  let polygon=raw.polygon;if(!polygon||polygon.length!==4){const [x,y,w,h]=raw.box;polygon=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];}
  polygon=polygon.map(([x,y])=>[Math.max(0,Math.min(file.width,x)),Math.max(0,Math.min(file.height,y))]);
  const xs=polygon.map(p=>p[0]),ys=polygon.map(p=>p[1]),x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)-x,h=Math.max(...ys)-y;
  if(![x,y,w,h].every(Number.isFinite)||w<2||h<2)return null;
  return {id:`${file.id}-b${++file.nextBoxId}`,number,retired:false,box:[x,y,w,h],polygon,score:raw.score??null,source:raw.source||'model',selected:false,status:'idle',token:0,result:null,editedText:'',hasEdited:false,verified:false,rotate180:false,previewURL:null};
}
async function detectFile(job,epoch){
  const file=findFile(job.fileId);if(!file)return;
  file.status='detecting';file.mode=job.mode;file.error='';renderFiles();if(state.currentId===file.id)renderCurrent();
  let bitmap=await workingBitmap(file);
  try{
    if(epoch!==state.epoch||!findFile(file.id))return;
    if(!file.thumbnailURL){const canvas=cropCanvas(bitmap,[0,0,bitmap.width,bitmap.height],130,160),blob=await canvasBlob(canvas,'image/jpeg');if(epoch===state.epoch&&findFile(file.id))file.thumbnailURL=URL.createObjectURL(blob);}
    if(state.currentId===file.id&&state.displayId!==file.id)await updateDisplay(file,bitmap,epoch);
    if(epoch!==state.epoch||!findFile(file.id))return;
    const result=await callWorker({type:'detect',bitmap,mode:job.mode||'default'},[bitmap]);bitmap=null;
    if(epoch!==state.epoch||!findFile(file.id))return;
    const boxes=(result.boxes||[]).slice().sort((a,b)=>a.box[1]-b.box[1]||a.box[0]-b.box[0]);
    // Only discard near-identical boxes. A slightly wider alternative may contain a missed character.
    for(const raw of boxes){const candidate=normalizeBox(raw,file,visibleBoxes(file).length+1);if(!candidate)continue;if(visibleBoxes(file).some(b=>overlap(b.box,candidate.box)>.96&&similarAngle(b,candidate)))continue;file.boxes.push(candidate);}
    file.status='ready';file.lastDetection=result;file.error='';file.warningLog=[...(file.warningLog||[]),{mode:job.mode,warnings:result.warnings||[],truncated:!!result.truncated}].slice(-5);
  }finally{bitmap?.close();}
}
function requestDetection(fileId,mode='detail'){
  const file=findFile(fileId);if(!file)return;
  if(state.detectQueue.some(j=>j.fileId===fileId&&j.mode===mode))return;
  state.detectQueue.unshift({type:'detect',fileId,mode,explicit:true});if(file.status==='error')file.status='waiting';
  updateSummary();status(mode==='detail'?'已排入更仔細的掃描；保留現有選框與結果。':'已排入掃描。');pump();
}
async function originalCrop(file,box){
  const epoch=state.epoch,view=box.pageView||file.view;
  return withDecode(async()=>{
    if(epoch!==state.epoch||!findFile(file.id))throw Error('此頁已移除。');
    const points=box.polygon.map(point=>PageRotation.inverse(point,view)).map(([x,y])=>[
      Math.max(0,Math.min(view.sourceWidth,x)),Math.max(0,Math.min(view.sourceHeight,y))]);
    if(file.kind==='pdf')return OfflinePDF.renderCrop(file.pdfSource,file.pdfPage,{workingWidth:view.sourceWidth,workingHeight:view.sourceHeight,polygon:points,isCancelled:()=>epoch!==state.epoch||!findFile(file.id)});
    const sx=file.originalWidth/view.sourceWidth,sy=file.originalHeight/view.sourceHeight;
    const polygon=points.map(([x,y])=>[x*sx,y*sy]),xs=polygon.map(p=>p[0]),ys=polygon.map(p=>p[1]);
    const left=Math.max(0,Math.floor(Math.min(...xs))),top=Math.max(0,Math.floor(Math.min(...ys))),right=Math.min(file.originalWidth,Math.ceil(Math.max(...xs))),bottom=Math.min(file.originalHeight,Math.ceil(Math.max(...ys)));
    if(right<=left||bottom<=top)throw Error('選框位於旋轉後的空白邊緣，請重新選取文字區域。');
    // A small canvas strips EXIF crop metadata while keeping source coordinates.
    const decoded=await createImageBitmap(file.file),canvas=document.createElement('canvas');let bitmap;
    canvas.width=right-left;canvas.height=bottom-top;
    try{canvas.getContext('2d').drawImage(decoded,-left,-top);bitmap=await createImageBitmap(canvas);}
    finally{decoded.close();canvas.width=canvas.height=0;}
    return {bitmap,polygon:polygon.map(([x,y])=>[x-left,y-top])};
  });
}
function recognitionPreview(crop,rotate180){
  let p=crop.polygon,w=Math.hypot(p[1][0]-p[0][0],p[1][1]-p[0][1]),h=Math.hypot(p[3][0]-p[0][0],p[3][1]-p[0][1]);
  if(h/w>=1.5){p=[p[1],p[2],p[3],p[0]];[w,h]=[h,w];}
  const ux=p[1][0]-p[0][0],uy=p[1][1]-p[0][1],vx=p[3][0]-p[0][0],vy=p[3][1]-p[0][1],det=ux*vy-uy*vx;
  if(Math.abs(det)<1e-6)return cropCanvas(crop.bitmap,[0,0,crop.bitmap.width,crop.bitmap.height],700,120,rotate180);
  const canvas=document.createElement('canvas'),scale=Math.min(700/w,120/h,2);
  canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
  const ctx=canvas.getContext('2d'),a=canvas.width*vy/det,b=-canvas.height*uy/det,c=-canvas.width*vx/det,d=canvas.height*ux/det;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  if(rotate180){ctx.translate(canvas.width,canvas.height);ctx.rotate(Math.PI);}
  ctx.transform(a,b,c,d,-a*p[0][0]-c*p[0][1],-b*p[0][0]-d*p[0][1]);ctx.drawImage(crop.bitmap,0,0);return canvas;
}
async function recognizeBox(job,epoch){
  const file=findFile(job.fileId),box=findBox(job.fileId,job.boxId);if(!file||!box||!validOCRJob(job))return;
  box.status='recognizing';box.error='';renderResults();renderFiles();updateSummary();
  let crop=await originalCrop(file,box);
  try{
    if(epoch!==state.epoch||!validOCRJob(job))return;
    const preview=recognitionPreview(crop,job.rotate180),blob=await canvasBlob(preview);
    if(epoch!==state.epoch||!validOCRJob(job))return;
    if(box.previewURL)URL.revokeObjectURL(box.previewURL);box.previewURL=URL.createObjectURL(blob);renderResults();
    const bitmap=crop.bitmap,result=await callWorker({type:'run',bitmap,box:[0,0,bitmap.width,bitmap.height],polygon:crop.polygon,rotate180:job.rotate180},[bitmap]);crop=null;
    if(epoch!==state.epoch||!validOCRJob(job))return;
    const best=result.results?.find(r=>r.model==='small6')?.best;
    if(!best)throw Error('模型未傳回主要結果。');
    if(typeof best.text!=='string'||!best.text.trim())throw Error('這一框沒有讀出字元，請嘗試轉 180°、重試或選擇其他候選框。');
    box.result=result;box.status='done';box.error='';
    if(!box.hasEdited)box.editedText=best.text;
  }finally{crop?.bitmap.close();}
}
function enqueueOCR(file,box){
  box.token++;box.status='queued';box.error='';box.verified=false;
  state.ocrQueue.push({type:'recognize',fileId:file.id,boxId:box.id,token:box.token,rotate180:box.rotate180});
  renderResults();renderFiles();updateSummary();pump();
}
function selectBox(fileId,boxId){
  const file=findFile(fileId),box=findBox(fileId,boxId);if(!file||!box)throw Error('找不到候選框。');if(file.rotating)return false;
  box.selected=!box.selected;
  if(box.selected){state.selectionOrder.push(box.id);if(box.result){box.status='done';renderResults();}else enqueueOCR(file,box);}
  else{state.selectionOrder=state.selectionOrder.filter(id=>id!==box.id);box.token++;box.status=box.result?'done':'idle';if(box.retired){file.boxes=file.boxes.filter(item=>item!==box);if(box.previewURL)URL.revokeObjectURL(box.previewURL);}}
  renderFiles();renderResults();if(fileId===state.currentId){draw();renderCandidates();}updateSummary();
  if(box.selected&&$('auto-next').checked&&fileId===state.currentId){const next=state.files[currentIndex()+1];if(next)navigate(next.id).catch(e=>status(e.message,true));}
  return box.selected;
}
function moveSelection(boxId,direction){
  if(direction!==-1&&direction!==1)throw Error('排序方向必須是上移或下移。');
  const index=state.selectionOrder.indexOf(boxId),next=index+direction;
  if(index<0||next<0||next>=state.selectionOrder.length)return false;
  [state.selectionOrder[index],state.selectionOrder[next]]=[state.selectionOrder[next],state.selectionOrder[index]];
  renderResults();status(`已移至第 ${next+1} 筆，複製與匯出順序已同步。`);return true;
}
function textValue(box){return box.editedText??box.result?.results?.find(r=>r.model==='small6')?.best?.text??'';}
async function copyText(value){try{await navigator.clipboard.writeText(value);status('已複製。');return true;}catch(error){status('瀏覽器未允許自動複製。請選取結果文字，再按 Ctrl+C／⌘C 或長按複製。',true);return false;}}
function renderCharacterScores(container,review){
  container.replaceChildren();
  for(const letter of review.letters){
    const item=node('span','character-score'+(letter.low?' low-score':''));
    item.dataset.position=String(letter.position);
    item.append(node('span','character-position',`第 ${letter.position} 碼`),node('b','',letter.character===' '?'␠':letter.character),node('span','',letter.score===null?'無分數':letter.score.toFixed(4)));
    item.title=`第 ${letter.position} 碼「${letter.character}」${letter.score===null?'沒有可對應的單字分數':`模型分數 ${letter.score.toFixed(4)}；提醒門檻 ${letter.threshold.toFixed(2)}`}`;
    if(letter.low)item.append(node('span','character-low-label','低於門檻'));
    container.append(item);
  }
}
function updateReviewNotice(card,box){
  const p=card._parts,review=p.review;
  const currentAmbiguous=OfflineOCRReview.findAmbiguousCharacters(textValue(box));
  p.reviewNotice.hidden=box.status!=='done'||(!review?.needsReview&&!currentAmbiguous.length);
  if(p.reviewNotice.hidden)return;
  p.reviewTitle.textContent=box.verified?'已核對圖片；仍保留核對提醒':'建議加強核對';
  const reasons=[];
  if(review?.ambiguousCharacters.length||currentAmbiguous.length){
    const origin=review?.ambiguousCharacters.length?(box.hasEdited&&currentAmbiguous.length?'本次預設結果與目前內容':'本次預設結果'):'目前內容';
    reasons.push(`${origin}含 O／0、I／i／1 或小寫 l 易混淆字元，請對照原圖核對。`);
  }
  if(review?.lowCharacters.length)reasons.push('單字低分：'+review.lowCharacters.map(letter=>`第 ${letter.position} 碼「${letter.character}」${letter.score.toFixed(4)}（門檻 ${letter.threshold.toFixed(2)}）`).join('、'));
  if(review?.hasDisagreement)reasons.push(`${review.candidateCount} 個候選文字有不同意見，請展開查看紅字差異。`);
  if(box.hasEdited)reasons.push('分數及候選差異依本次預設結果；易混淆字元也會檢查目前內容。');
  p.reviewReason.textContent=reasons.join('\n');
}
function createReviewGuideLink(){
  const link=node('a','review-guide-link','核對規則與品牌查證（另開分頁）');
  link.href='review-guide.html';link.target='_blank';link.rel='noopener noreferrer';return link;
}
function createResultCard(file,box){
  const card=node('article','result-card');card.dataset.resultId=box.id;
  const top=node('div','result-top'),heading=node('div','result-title-group'),ordering=node('div','result-order-controls'),orderNumber=node('span','order-number'),moveUp=node('button','subtle move-up','↑'),moveDown=node('button','subtle move-down','↓');
  orderNumber.dataset.testid='order-number';moveUp.type=moveDown.type='button';moveUp.title='上移一筆';moveDown.title='下移一筆';moveUp.setAttribute('aria-label','上移一筆');moveDown.setAttribute('aria-label','下移一筆');moveUp.addEventListener('click',()=>moveSelection(box.id,-1));moveDown.addEventListener('click',()=>moveSelection(box.id,1));ordering.append(orderNumber,moveUp,moveDown);
  const title=node('strong','result-file-title',`${file.name} · 框 ${box.number}`),actions=node('div','result-actions'),locate=node('button','subtle','回到圖片'),remove=node('button','text-button','取消選取');locate.type=remove.type='button';locate.addEventListener('click',()=>navigate(file.id));remove.addEventListener('click',()=>selectBox(file.id,box.id));actions.append(locate,remove);heading.append(ordering,title);top.append(heading,actions);card.append(top);
  const img=node('img','result-preview');img.alt=`${file.name} 框 ${box.number} 原圖裁切`;img.loading='lazy';img.decoding='async';img.hidden=true;card.append(img);
  const reviewNotice=node('div','review-notice'),reviewHeading=node('div','review-heading'),reviewIcon=node('span','review-icon','⚠\uFE0E'),reviewTitle=node('strong'),reviewReason=node('p','review-reason'),reviewButton=node('button','subtle review-open','查看疑點與逐字分數'),reviewActions=node('div','review-actions');reviewNotice.hidden=true;reviewNotice.setAttribute('role','status');reviewIcon.setAttribute('aria-hidden','true');reviewHeading.append(reviewIcon,reviewTitle);reviewButton.type='button';reviewButton.addEventListener('click',()=>{card._parts.details.open=true;card._parts.details.querySelector('summary').focus();});reviewActions.append(reviewButton,createReviewGuideLink());reviewNotice.append(reviewHeading,reviewReason,reviewActions);card.append(reviewNotice);
  const textarea=node('textarea','result-value');textarea.rows=1;textarea.spellcheck=false;textarea.autocapitalize='off';textarea.autocomplete='off';textarea.setAttribute('aria-label',`${file.name} 框 ${box.number} 辨識結果`);textarea.dataset.testid='result-text';textarea.addEventListener('input',()=>{box.editedText=textarea.value;box.hasEdited=true;box.verified=false;card.querySelector('.verified-input').checked=false;updateReviewNotice(card,box);updateSummary();});card.append(textarea);
  card.append(node('p','result-meta'));
  const bottom=node('div','result-bottom'),verified=node('label','checkbox'),check=node('input','verified-input');check.type='checkbox';check.addEventListener('change',()=>{box.verified=check.checked;updateReviewNotice(card,box);updateSummary();});verified.append(check,document.createTextNode('已核對圖片'));
  const controls=node('div','result-actions'),retry=node('button','subtle','重試'),rotate=node('button','subtle','轉 180° 重讀'),copy=node('button','','複製');for(const b of [retry,rotate,copy])b.type='button';retry.addEventListener('click',()=>enqueueOCR(file,box));rotate.addEventListener('click',()=>{box.rotate180=!box.rotate180;enqueueOCR(file,box);});copy.addEventListener('click',()=>copyText(textValue(box)));controls.append(retry,rotate,copy);bottom.append(verified,controls);card.append(bottom);
  const details=node('details'),summary=node('summary','','檢視辨識候選'),help=node('p','candidate-diff-help','紅字表示與本次預設辨識不同的字元；〔缺字〕只供核對，不會加入輸出。採用或手動修改後，比較基準仍保留本次預設結果。'),baselineLine=node('p','candidate-diff-help'),baseline=node('code','candidate-baseline');baselineLine.append(document.createTextNode('比較基準：'),baseline);
  const scoreHelp=node('p','candidate-diff-help',`本次預設結果的逐字分數（非正確率）；單字低於 ${OfflineOCRReview.defaultThreshold.toFixed(2)} 時提醒。`),characterScores=node('div','character-scores');
  const scroll=node('div','table-scroll'),table=node('table','recognition-table'),thead=node('thead'),head=node('tr');for(const text of ['處理方式','辨識結果','平均分數',''])head.append(node('th','',text));thead.append(head);const tbody=node('tbody');table.append(thead,tbody);scroll.append(table);details.append(summary,help,baselineLine,scoreHelp,characterScores,scroll);card.append(details);
  card._parts={img,textarea,meta:card.querySelector('.result-meta'),check,retry,rotate,copy,details,tbody,baseline,characterScores,reviewNotice,reviewTitle,reviewReason,orderNumber,moveUp,moveDown,payload:null,review:null};return card;
}
function updateResultCard(card,file,box){
  const p=card._parts,done=box.status==='done',working=box.status==='queued'||box.status==='recognizing';
  if(box.previewURL&&p.img.getAttribute('src')!==box.previewURL){p.img.src=box.previewURL;p.img.hidden=false;}
  p.textarea.disabled=!box.result||working;
  if(document.activeElement!==p.textarea)p.textarea.value=box.result?textValue(box):'';
  p.textarea.placeholder=box.status==='error'?'辨識失敗，請重試':box.status==='recognizing'?'正在精讀…':'已加入辨識佇列…';
  p.copy.disabled=!done;p.check.disabled=!done;p.check.checked=box.verified;p.retry.disabled=working;p.rotate.disabled=working;
  p.meta.classList.toggle('error',box.status==='error');
  const primary=box.result?.results.find(r=>r.model==='small6');
  p.meta.textContent=box.status==='error'?`辨識失敗：${box.error}`:working?(box.status==='queued'?'等待前一項完成；已選框優先於後續背景掃描。':'正在以 4 種方式精讀此框…'):primary?`${primary.best.variantName} · 平均模型分數 ${primary.best.confidence.toFixed(4)}（非正確率）${box.rotate180?' · 已轉 180°':''}${box.hasEdited?' · 保留人工修改':''}`:'';
  if(box.retired)p.meta.textContent+=' · 旋轉前已選結果（舊框已清除）';
  p.details.hidden=!box.result;
  if(box.result&&p.payload!==box.result){
    const reference=primary?.best?.text||'';p.baseline.textContent=reference;p.tbody.replaceChildren();
    p.review=OfflineOCRReview.analyze(primary);renderCharacterScores(p.characterScores,p.review);
    for(const candidate of primary?.candidates||[]){
      const tr=node('tr'),candidateText=node('td','candidate-text ocr-diff-text');OfflineTextDiff.render(candidateText,reference,candidate.text);
      const scoresDetails=node('details','candidate-scores'),scores=node('div','character-scores');
      scoresDetails.append(node('summary','','逐字分數'),scores);renderCharacterScores(scores,OfflineOCRReview.analyze({best:candidate}));candidateText.append(scoresDetails);
      tr.append(node('td','',candidate.variantName),candidateText,node('td','',candidate.confidence.toFixed(4)));
      const td=node('td'),adopt=node('button','subtle','採用');adopt.type='button';adopt.addEventListener('click',()=>{box.editedText=candidate.text;box.hasEdited=true;box.verified=false;updateResultCard(card,file,box);updateSummary();});td.append(adopt);tr.append(td);p.tbody.append(tr);
    }
    p.payload=box.result;
  }
  updateReviewNotice(card,box);
}
function renderResults(){
  const rows=selectedRows(),keep=new Set(rows.map(r=>r.box.id));
  for(const [id,card]of resultNodes)if(!keep.has(id)){card.remove();resultNodes.delete(id);}
  $('empty-results').hidden=!!rows.length;
  rows.forEach(({file,box,order},index)=>{let card=resultNodes.get(box.id);if(!card){card=createResultCard(file,box);resultNodes.set(box.id,card);}updateResultCard(card,file,box);card.dataset.order=String(order);card._parts.orderNumber.textContent=String(order);card._parts.orderNumber.setAttribute('aria-label',`輸出順序第 ${order} 筆`);card._parts.moveUp.disabled=index===0;card._parts.moveDown.disabled=index===rows.length-1;const previous=index?resultNodes.get(rows[index-1].box.id):$('empty-results');if(previous.nextElementSibling!==card)previous.after(card);});
  updateSummary();
}
function releaseFile(file){if(file.thumbnailURL)URL.revokeObjectURL(file.thumbnailURL);for(const box of file.boxes)if(box.previewURL)URL.revokeObjectURL(box.previewURL);}
async function removeFile(id){
  const file=findFile(id);if(!file)return;const epoch=state.epoch,index=state.files.indexOf(file),wasCurrent=state.currentId===id,removed=new Set(file.boxes.map(box=>box.id));state.selectionOrder=state.selectionOrder.filter(boxId=>!removed.has(boxId));releaseFile(file);state.files.splice(index,1);state.detectQueue=state.detectQueue.filter(j=>j.fileId!==id);state.ocrQueue=state.ocrQueue.filter(j=>j.fileId!==id);
  if(wasCurrent){state.display?.close();state.display=null;state.displayId=null;state.currentId=null;state.navigationToken++;}
  renderFiles();renderResults();renderCurrent();
  try{if(file.pdfSource&&!state.files.some(item=>item.pdfSource===file.pdfSource))await OfflinePDF.release(file.pdfSource);}
  finally{
    if(epoch===state.epoch){
      if(wasCurrent&&!state.currentId){const next=state.files[Math.min(index,state.files.length-1)];if(next)await navigate(next.id);}
      renderFiles();renderResults();renderCurrent();status('已移除此頁與其選框結果。');
    }
  }
}
function clearAll(){
  state.epoch++;state.navigationToken++;stopWorker('已清空這一批。');for(const file of state.files)releaseFile(file);
  state.display?.close();state.display=null;state.displayId=null;state.files=[];state.selectionOrder=[];state.currentId=null;state.detectQueue=[];state.ocrQueue=[];state.active=null;state.pumping=false;state.paused=false;state.manual=false;state.drag=null;
  state.importPending=0;state.importLabel='';
  $('image').value='';source.width=source.height=1;warning('');renderFiles();renderResults();renderCurrent();status('已清空圖片、PDF 頁面與辨識結果。');
  return OfflinePDF.reset();
}
function addFiles(files){
  const incoming=Array.from(files),epoch=state.epoch;
  if(!incoming.length)return Promise.resolve();
  state.importPending++;updateSummary();
  const task=importChain.then(()=>importFiles(incoming,epoch));
  importChain=task.catch(()=>{});
  return task.finally(()=>{if(epoch===state.epoch){state.importPending=Math.max(0,state.importPending-1);if(!state.importPending)state.importLabel='';updateSummary();}});
}
async function importFiles(incoming,epoch){
  const isCancelled=()=>epoch!==state.epoch,accepted=[],rejected=[],opened=[];
  let committed=false;
  try{
    for(const file of incoming){
      if(isCancelled())return;
      const pdf=file.type==='application/pdf'||/\.pdf$/i.test(file.name);
      if(!pdf&&!(file.type.startsWith('image/')||/\.(png|jpe?g|webp|bmp|gif|avif|heic|heif)$/i.test(file.name))){rejected.push(`${file.name}（請選擇圖片或 PDF）`);continue;}
      if(file.size>50*1024*1024){rejected.push(`${file.name}（超過單檔 50 MiB，請先縮小或分割）`);continue;}
      let pdfSource=null;
      if(pdf){
        state.importLabel=`正在讀取 PDF 頁數：${file.name}`;updateSummary();
        try{pdfSource=await withDecode(()=>OfflinePDF.inspect(file,{isCancelled}));opened.push(pdfSource);}
        catch(error){if(isCancelled())return;rejected.push(`${file.name}（${error.message||'無法讀取 PDF'}）`);continue;}
        if(isCancelled())return;
      }
      const count=pdfSource?pdfSource.pageCount:1;
      if(state.files.length+accepted.length+count>MAX_FILES){
        warning(`這次沒有加入任何新檔案：${file.name}${pdfSource?' 拆成 '+count+' 頁後':''}會讓總數超過 ${MAX_FILES} 張／頁上限。目前有 ${state.files.length} 張／頁；請先匯出並清空這批，或選擇較少頁的 PDF。`);
        return;
      }
      for(let page=1;page<=count;page++)accepted.push({file,kind:pdf?'pdf':'image',sourceName:file.name,pdfSource,pdfPage:pdf?page:null,pdfPageCount:pdf?count:null,name:pdf?`${file.name} · 第 ${page}／${count} 頁`:file.name});
    }
    if(isCancelled())return;
    for(const entry of accepted){const item={...entry,id:`f${++state.nextId}`,status:'waiting',boxes:[],error:'',thumbnailURL:null,width:0,height:0,originalWidth:0,originalHeight:0,rotation:0,rotating:false,rotationTask:null,view:null,nextBoxId:0};state.files.push(item);state.detectQueue.push({type:'detect',fileId:item.id,mode:'default'});}
    committed=true;
    const warnings=[];if(rejected.length)warnings.push(`以下 ${rejected.length} 個檔案未加入：\n${rejected.join('\n')}`);
    if(state.files.length>recommended)warnings.push(`目前 ${state.files.length} 張／頁，超過這台裝置的保守建議 ${recommended}。系統會逐頁處理；若手機發熱或瀏覽器不穩，請分批並先匯出完成結果。`);
    const bytes=[...new Set(state.files.map(item=>item.file))].reduce((sum,file)=>sum+file.size,0);if(bytes>300*1024*1024)warnings.push('原始檔案合計超過 300 MiB，建議縮小檔案或分批。PDF 每頁共用原檔，不重複計算檔案大小。');
    warning(warnings.join('\n\n'));renderFiles();renderResults();updateSummary();
    if(!state.currentId&&state.files.length){state.currentId=state.files[0].id;renderFiles();renderCurrent();}
    if(accepted.length)pump();else status('沒有可加入的圖片或 PDF，請查看上方提示。',true);
  }finally{if(!committed)for(const pdfSource of opened)await OfflinePDF.release(pdfSource);}
}
$('image').addEventListener('change',()=>{const files=Array.from($('image').files);$('image').value='';addFiles(files).catch(e=>status(e.message,true));});
$('pause').addEventListener('click',()=>{state.paused=!state.paused;updateSummary();renderFiles();if(state.paused)status('已要求暫停背景掃描，當前項目完成後停止。已選框仍會繼續精讀。');else pump();});
$('clear').addEventListener('click',()=>clearAll().catch(e=>status('清理 PDF 資源時發生問題：'+e.message,true)));$('remove-image').addEventListener('click',()=>removeFile(state.currentId).catch(e=>status('移除頁面時發生問題：'+e.message,true)));
$('previous').addEventListener('click',()=>{const file=state.files[currentIndex()-1];if(file)navigate(file.id);});
$('next').addEventListener('click',()=>{const file=state.files[currentIndex()+1];if(file)navigate(file.id);});
$('more-boxes').addEventListener('click',()=>requestDetection(state.currentId));
for(const [id,direction]of [['rotate-left',-1],['rotate-right',1]])$(id).addEventListener('click',()=>rotateFile(state.currentId,direction).catch(error=>status('無法旋轉此頁：'+error.message,true)));
$('custom-rotation').addEventListener('submit',event=>{event.preventDefault();if(!$('custom-rotation').reportValidity())return;rotateTo(state.currentId,$('rotation-angle').valueAsNumber).catch(error=>status('無法旋轉此頁：'+error.message,true));});
$('manual').addEventListener('click',()=>{state.manual=!state.manual;state.drag=null;updateSummary();draw();status(state.manual?'手動補框已開啟：拖出一整行序號。':'已回到點選候選框。');});
$('verified-only').addEventListener('change',updateSummary);
function position(event){const file=currentFile(),rect=source.getBoundingClientRect();return [Math.max(0,Math.min(file.width,(event.clientX-rect.left)*file.width/rect.width)),Math.max(0,Math.min(file.height,(event.clientY-rect.top)*file.height/rect.height))];}
function addManualBox(box){
  const file=currentFile();if(!file||!file.width||file.rotating)throw Error('請先開啟圖片並等待旋轉完成。');
  const [x0,y0,w0,h0]=box.map(Number);if(![x0,y0,w0,h0].every(Number.isFinite))throw Error('範圍無效。');const x=Math.max(0,Math.min(file.width-1,x0)),y=Math.max(0,Math.min(file.height-1,y0)),w=Math.min(file.width-x,Math.max(1,w0)),h=Math.min(file.height-y,Math.max(1,h0));
  const candidate=normalizeBox({box:[x,y,w,h],source:'manual'},file,visibleBoxes(file).length+1);if(!candidate)throw Error('框選範圍太小。');file.boxes.push(candidate);renderCurrent();selectBox(file.id,candidate.id);return candidate.id;
}
source.addEventListener('pointerdown',event=>{if(!currentFile()||currentFile().rotating||!state.display)return;const [x,y]=position(event);state.drag={start:[x,y],client:[event.clientX,event.clientY],box:[x,y,0,0]};if(state.manual){source.setPointerCapture(event.pointerId);event.preventDefault();}});
source.addEventListener('pointermove',event=>{if(!state.drag||!state.manual)return;const [x,y]=position(event),[sx,sy]=state.drag.start;state.drag.box=[Math.min(x,sx),Math.min(y,sy),Math.abs(x-sx),Math.abs(y-sy)];draw();});
source.addEventListener('pointercancel',()=>{state.drag=null;draw();});
source.addEventListener('pointerup',event=>{
  if(!state.drag||!currentFile())return;const drag=state.drag;state.drag=null;
  if(state.manual){const box=drag.box;if(box[2]>3&&box[3]>3){state.manual=false;addManualBox(box);status('已補框並加入辨識佇列。');}draw();updateSummary();return;}
  if(Math.hypot(event.clientX-drag.client[0],event.clientY-drag.client[1])>8)return;
  const [x,y]=position(event),file=currentFile(),hits=visibleBoxes(file).filter(b=>pointInPolygon(x,y,b.polygon)).sort((a,b)=>a.box[2]*a.box[3]-b.box[2]*b.box[3]);if(hits.length)selectBox(file.id,hits[0].id);
});
document.addEventListener('keydown',event=>{if(/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)||event.ctrlKey||event.metaKey||event.altKey)return;if(event.key==='ArrowRight')$('next').click();if(event.key==='ArrowLeft')$('previous').click();});
function exportTXT(){return exportRows().map(({box})=>textValue(box)).join('\n');}
function csvCell(value){return '"'+String(value??'').replaceAll('"','""')+'"';}
function exportCSV(){const header=['order','image','box','serial','verified','model_score'];const rows=exportRows().map(({file,box,order})=>[order,file.name,box.number,textValue(box),box.verified?'yes':'no',box.result.results.find(r=>r.model==='small6').best.confidence]);return '\ufeff'+[header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');}
function download(content,type,extension){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=`serial_ocr_${new Date().toISOString().slice(0,10)}.${extension}`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);status(`已匯出 ${exportRows().length} 筆完成結果。請確認待處理或失敗的選框。`);}
$('copy-all').addEventListener('click',()=>copyText(exportTXT()));$('export-txt').addEventListener('click',()=>download(exportTXT(),'text/plain;charset=utf-8','txt'));$('export-csv').addEventListener('click',()=>download(exportCSV(),'text/csv;charset=utf-8','csv'));

const cachePromise=(async()=>{
  if(FILE_MODE)throw Error('直接開啟 HTML 無法準備模型。請雙擊 START_MAC.command（macOS）或 START_WINDOWS.bat（Windows），再使用自動開啟的本機網址。');
  if(!('serviceWorker'in navigator))throw Error('此瀏覽器不支援離線快取，請使用新版 Chrome 或 Edge。');
  const started=Date.now();let registration;
  try{registration=await navigator.serviceWorker.register('sw.js',{scope:'./',updateViaCache:'none'});}catch(error){registration=await navigator.serviceWorker.getRegistration('./');if(!registration?.active)throw error;}
  let readyTimeout;
  const installationFailed=new Promise((resolve,reject)=>{
    const observe=worker=>{if(!worker)return;const inspect=()=>{if(worker.state==='redundant')reject(Error('離線資源儲存失敗，請確認可用空間後重新整理。'));};inspect();worker.addEventListener('statechange',inspect);};
    observe(registration.installing);registration.addEventListener('updatefound',()=>observe(registration.installing));
    readyTimeout=setTimeout(()=>reject(Error('離線準備逾時，請保持本機啟動程式開啟後重新整理。')),180000);
  });
  try{await Promise.race([navigator.serviceWorker.ready,installationFailed]);}finally{clearTimeout(readyTimeout);}
  const required=globalThis.OFFLINE_ASSETS;
  while(Date.now()-started<180000){const cache=await caches.open(CACHE_NAME);let complete=true;for(const path of required)if(!await cache.match(new URL(path,location.href).href)){complete=false;break;}if(complete){state.cacheReady=true;$('cache-status').textContent='完整離線就緒：程式、偵測模型與序號辨識模型都在本機。';return true;}await delay(300);}
  throw Error('資源尚未完整，請保持網路連線並確認網站檔案完整，再重新整理。本機試用時請保持啟動程式開啟。');
})();
cachePromise.catch(error=>{$('cache-status').classList.add('error');$('cache-status').textContent='離線資源尚未完成：'+error.message;});
async function whenIdle(){while(state.importPending||state.pumping||state.active||state.files.some(f=>f.rotating)||state.ocrQueue.some(validOCRJob)||state.detectQueue.some(j=>!state.paused||j.explicit))await delay(40);return snapshot();}
async function waitForFile(id){for(;;){const file=findFile(id);if(!file)throw Error('找不到圖片。');if(file.status==='ready'||file.status==='error')return snapshot().files.find(f=>f.id===id);await delay(40);}}
function snapshotBox(b){return {id:b.id,number:b.number,box:b.box.slice(),polygon:b.polygon.map(p=>p.slice()),score:b.score,source:b.source,retired:!!b.retired,selected:b.selected,status:b.status,editedText:b.editedText,verified:b.verified,rotate180:b.rotate180,error:b.error||'',result:b.result};}
function snapshot(){return {version:APP_VERSION,cacheName:CACHE_NAME,selectionOrder:selectedRows().map(({box})=>box.id),files:state.files.map(f=>({id:f.id,name:f.name,kind:f.kind,sourceName:f.sourceName,pdfPage:f.pdfPage,pdfPageCount:f.pdfPageCount,rotation:f.rotation,rotating:f.rotating,status:f.status,width:f.width,height:f.height,originalWidth:f.originalWidth,originalHeight:f.originalHeight,error:f.error,boxes:visibleBoxes(f).map(snapshotBox),savedResults:f.boxes.filter(b=>b.retired).map(snapshotBox)})),currentId:state.currentId,paused:state.paused,importing:state.importPending>0,pdfStats:OfflinePDF.getStats(),active:state.active?{...state.active}:null,pendingDetection:state.detectQueue.map(j=>({...j})),pendingRecognition:state.ocrQueue.filter(validOCRJob).map(j=>({...j})),busy:state.pumping,cacheReady:state.cacheReady,metrics:{...state.metrics},history:state.history.map(j=>({...j}))};}
window.offlineOCRTest={waitForCache:()=>cachePromise,getState:snapshot,selectBox,moveSelection,moveFile,navigate,rotateFile,rotateTo,pause:()=>{state.paused=true;updateSummary();renderFiles();},resume:()=>{state.paused=false;updateSummary();pump();},remove:removeFile,clear:clearAll,whenIdle,waitForFile,exportTXT,exportCSV,setROI:addManualBox,requestDetection,addFiles,loadModels:async()=>{await whenIdle();return callWorker({type:'load'});}};
updateSummary();
