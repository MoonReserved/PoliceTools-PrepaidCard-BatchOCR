'use strict';
importScripts('runtime/ort.wasm.min.js');
importScripts('detection.js');
ort.env.wasm.wasmPaths=new URL('runtime/',self.location.href).href;
ort.env.wasm.numThreads=1;
ort.env.wasm.proxy=false;
ort.env.telemetry=false;
const specs={small6:{name:'PP-OCRv6 small',model:'models/small6.onnx',dict:'models/small6.dict.json'}};
const sessions=new Map(),dictionaries=new Map();
const variants=[{id:'original',name:'原始裁切',trim:false,pad:0,stretch:1},{id:'trim4',name:'修除空白＋白邊',trim:true,pad:4,stretch:1},{id:'trim4_x1.5',name:'修整後橫向 1.5 倍',trim:true,pad:4,stretch:1.5},{id:'trim4_x2',name:'修整後橫向 2 倍',trim:true,pad:4,stretch:2}];
function canvas(w,h){return new OffscreenCanvas(Math.max(1,Math.round(w)),Math.max(1,Math.round(h)));}
async function load(id){
  if(sessions.has(id))return;
  if(!specs[id])throw Error('未知模型');
  const response=await fetch(new URL(specs[id].dict,self.location.href));
  if(!response.ok)throw Error('無法讀取本機字典，請確認離線資源已準備完成。');
  dictionaries.set(id,await response.json());
  sessions.set(id,await ort.InferenceSession.create(new URL(specs[id].model,self.location.href).href,{executionProviders:['wasm'],graphOptimizationLevel:'all'}));
}
function makeCrop(image,box,variant){
  const [x,y,w,h]=box,c=canvas(w,h),ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(image,x,y,w,h,0,0,w,h);
  let l=0,t=0,r=w,b=h;
  if(variant.trim){
    const pixels=ctx.getImageData(0,0,w,h).data;l=w;t=h;r=0;b=0;
    for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
      const i=(yy*w+xx)*4;
      if(.299*pixels[i]+.587*pixels[i+1]+.114*pixels[i+2]<180){l=Math.min(l,xx);r=Math.max(r,xx+1);t=Math.min(t,yy);b=Math.max(b,yy+1);}
    }
    if(r<=l||b<=t){l=0;t=0;r=w;b=h;}
    l=Math.max(0,l-2);t=Math.max(0,t-2);r=Math.min(w,r+2);b=Math.min(h,b+2);
  }
  const {pad,stretch}=variant,out=canvas((r-l+2*pad)*stretch,b-t+2*pad),o=out.getContext('2d');
  o.fillStyle='#fff';o.fillRect(0,0,out.width,out.height);o.imageSmoothingEnabled=true;o.imageSmoothingQuality='high';
  o.drawImage(c,l,t,r-l,b-t,pad*stretch,pad,(r-l)*stretch,b-t);
  return out;
}
function tensorFor(c){
  const h=48,w=Math.ceil(h*c.width/c.height),tw=Math.max(320,w);
  if(tw>4096)throw Error('框選的長寬比例過大，請縮小到單行序號後重試。');
  const resized=canvas(w,h),ctx=resized.getContext('2d',{willReadFrequently:true});
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='low';ctx.drawImage(c,0,0,w,h);
  const pixels=ctx.getImageData(0,0,w,h).data,data=new Float32Array(3*h*tw);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let ch=0;ch<3;ch++)data[ch*h*tw+y*tw+x]=pixels[(y*w+x)*4+2-ch]/127.5-1;
  return new ort.Tensor('float32',data,[1,3,h,tw]);
}
function decode(output,chars){
  const steps=output.dims[1],classes=output.dims[2];let text='',last=-1;const conf=[];
  if(classes!==chars.length)throw Error('模型與字典不相符。');
  for(let t=0;t<steps;t++){
    let k=0,v=-Infinity;
    for(let i=0;i<classes;i++){const score=output.data[t*classes+i];if(score>v){k=i;v=score;}}
    if(k!==0&&k!==last){text+=chars[k];conf.push(v);}last=k;
  }
  return {text,confidence:conf.length?conf.reduce((a,b)=>a+b,0)/conf.length:0,charConfidence:conf};
}
let busy=false;
self.onmessage=async({data:message})=>{
  const {requestId,type}=message;
  if(busy){self.postMessage({requestId,type:'error',error:'前一次辨識尚未完成。'});return;}
  busy=true;let bitmap=message.bitmap;const prepared=[];
  try{
    if(type==='detect'){
      if(!bitmap)throw Error('缺少本機圖片。');
      const result=await detectText(bitmap,{mode:message.mode||'default',progress:detail=>self.postMessage({requestId,type:'progress',phase:'detect',...detail})});
      self.postMessage({requestId,type:'done',result});return;
    }
    const ids=['small6'];
    for(const id of ids){self.postMessage({requestId,type:'progress',phase:'load',model:id});await load(id);}
    if(type==='load'){self.postMessage({requestId,type:'done',result:{loaded:ids}});return;}
    if(type!=='run'||!bitmap)throw Error('缺少本機圖片。');
    let box=message.box;
    if(!Array.isArray(box)||box.length!==4||box.some(v=>!Number.isFinite(v))||box[2]<1||box[3]<1||box[0]<0||box[1]<0||box[0]+box[2]>bitmap.width||box[1]+box[3]>bitmap.height)throw Error('框選範圍無效。');
    let input=bitmap;
    if(message.polygon){
      if(!Array.isArray(message.polygon)||message.polygon.length!==4||message.polygon.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isFinite(v))))throw Error('候選框座標無效。');
      input=rectifyQuad(bitmap,message.polygon);box=[0,0,input.width,input.height];
    }
    if(message.rotate180){const turned=canvas(input.width,input.height),ctx=turned.getContext('2d');ctx.translate(turned.width,turned.height);ctx.rotate(Math.PI);ctx.drawImage(input,0,0);input=turned;box=[0,0,input.width,input.height];}
    for(const variant of variants)prepared.push({variant,tensor:tensorFor(makeCrop(input,box,variant))});
    const started=performance.now(),results=[];
    for(const id of ids){
      const session=sessions.get(id),candidates=[];
      for(let i=0;i<prepared.length;i++){
        self.postMessage({requestId,type:'progress',phase:'infer',model:id,index:i+1,total:prepared.length});
        const {variant,tensor}=prepared[i],t=performance.now(),output=await session.run({[session.inputNames[0]]:tensor});
        const r={...decode(output[session.outputNames[0]],dictionaries.get(id)),variant:variant.id,variantName:variant.name,milliseconds:performance.now()-t,inputShape:tensor.dims};
        candidates.push(r);
        for(const value of Object.values(output))if(typeof value.dispose==='function')value.dispose();
      }
      const best=candidates.reduce((a,b)=>b.confidence>a.confidence?b:a);
      results.push({model:id,modelName:specs[id].name,best,candidates});
    }
    self.postMessage({requestId,type:'done',result:{results,totalMilliseconds:performance.now()-started,rectified:!!message.polygon,rotate180:!!message.rotate180}});
  }catch(error){self.postMessage({requestId,type:'error',error:error.message||String(error)});}
  finally{for(const {tensor} of prepared)if(typeof tensor.dispose==='function')tensor.dispose();if(bitmap)bitmap.close();busy=false;}
};
