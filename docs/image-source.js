'use strict';
// Normalize uncommon formats once, locally. Keep native JPEG/EXIF decoding intact.
(function(root){
  const MAX_PIXELS=80000000;
  const RAW=/\.(dng|cr2|cr3|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|raw)$/i;
  const active=new Set();
  function classify(file,bytes){
    const name=file.name||'',type=(file.type||'').toLowerCase();
    if(RAW.test(name)||/image\/(x-.*raw|x-adobe-dng|x-canon-cr2|x-nikon-nef)/.test(type))return 'raw';
    const text=String.fromCharCode(...bytes);
    if(text.startsWith('%PDF-'))return 'pdf';
    if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'native';
    if(text.startsWith('\x89PNG')||text.startsWith('GIF8')||text.startsWith('BM')||(text.startsWith('RIFF')&&text.slice(8,12)==='WEBP'))return 'native';
    if(text.startsWith('II*\0')||text.startsWith('MM\0*'))return 'tiff';
    if(text.startsWith('II+\0')||text.startsWith('MM\0+'))return 'bigtiff';
    if(text.slice(4,8)==='ftyp'){
      const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),end=Math.min(bytes.length,view.getUint32(0));
      const brands=[text.slice(8,12)];for(let i=16;i+4<=end;i+=4)brands.push(text.slice(i,i+4));
      if(brands.some(b=>['avif','avis'].includes(b)))return 'native';
      if(brands.some(b=>['heic','heix','hevc','hevx','heim','heis','hevm','hevs','mif1','msf1'].includes(b)))return 'heif';
    }
    if(type==='application/pdf'||/\.pdf$/i.test(name))return 'pdf';
    if(/\.(heic|heif|hif|heics|heifs)$/i.test(name)||/^image\/hei[cf]/.test(type))return 'heif';
    if(/\.tiff?$/i.test(name)||['image/tiff','image/x-tiff'].includes(type))return 'tiff';
    if(type.startsWith('image/')||/\.(png|jpe?g|jfif|jpe|webp|bmp|dib|gif|avif|svg|ico)$/i.test(name))return 'native';
    return 'unknown';
  }
  async function identify(file){return classify(file,new Uint8Array(await file.slice(0,512).arrayBuffer()));}
  function checkSize(width,height){
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||!Number.isSafeInteger(width*height))throw Error('圖片尺寸無效或檔案已損毀。');
    if(width*height>MAX_PIXELS)throw Error('圖片超過 8,000 萬像素，請先另存較小版本。');
  }
  async function decode(file){
    let bitmap;
    try{bitmap=await createImageBitmap(file);}
    catch{
      // Some browsers decode SVG and TIFF through <img> but not directly as a Blob.
      const url=URL.createObjectURL(file),img=new Image();
      try{
        await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('此圖片無法解碼；可能已損毀或瀏覽器不支援此格式，請另存為 JPG／PNG 後重試。'));img.src=url;});
        checkSize(img.naturalWidth,img.naturalHeight);bitmap=await createImageBitmap(img);
      }finally{img.src='';URL.revokeObjectURL(url);}
    }
    try{checkSize(bitmap.width,bitmap.height);return bitmap;}catch(error){bitmap.close();throw error;}
  }
  function convert(file,format,maxPages,isCancelled){
    return new Promise((resolve,reject)=>{
      const worker=new Worker('image-decoder-worker.js');let timer;
      const finish=(error,result)=>{clearTimeout(timer);active.delete(cancel);worker.terminate();error?reject(error):resolve(result);};
      const cancel=()=>finish(Error('已取消圖片匯入。'));
      active.add(cancel);
      worker.onmessage=({data})=>{
        if(isCancelled())return cancel();
        if(data.error){const error=Error(data.error);error.code=data.code;finish(error);}else finish(null,data);
      };
      worker.onerror=event=>{event.preventDefault();finish(Error('圖片轉換失敗，請另存為 JPG／PNG，或連網重新載入完整離線資源後重試。'));};
      timer=setTimeout(()=>finish(Error('圖片轉換逾時，請縮小圖片或另存為 JPG／PNG 後重試。')),120000);
      worker.postMessage({file,format,maxPages,maxPixels:MAX_PIXELS});
    });
  }
  async function prepare(file,format,{maxPages=200,isCancelled=()=>false}={}){
    if(format==='raw')throw Error('尚不支援相機 RAW／DNG，請先用相機或照片軟體匯出 JPG／PNG。');
    if(format==='bigtiff')throw Error('尚不支援 BigTIFF，請先另存為一般 TIFF、PNG 或 PDF。');
    if(format==='unknown')throw Error('請選擇可讀取的圖片或 PDF；特殊格式請先另存為 JPG／PNG。');
    if(isCancelled())throw Error('已取消圖片匯入。');
    if(format==='heif'||format==='tiff')return convert(file,format,maxPages,isCancelled);
    const bitmap=await decode(file);bitmap.close();
    return {pages:[file],notice:''};
  }
  const api={identify,prepare,decode,reset(){for(const cancel of [...active])cancel();},classify,checkSize};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.OfflineImage=api;
})(globalThis);
