'use strict';
// A fresh worker per source releases the codec heap after conversion/cancellation.
function dimensions(width,height,maxPixels){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw Error('圖片尺寸無效或檔案已損毀。');
  if(width*height>maxPixels)throw Error('圖片超過 8,000 萬像素，請先另存較小版本。');
}
async function png(data,width,height,orientation=1){
  const raw=new OffscreenCanvas(width,height),ctx=raw.getContext('2d');
  let output=raw;
  try{
    ctx.putImageData(new ImageData(new Uint8ClampedArray(data.buffer,data.byteOffset,data.byteLength),width,height),0,0);
    if(orientation>1&&orientation<=8){
      const swap=orientation>=5;output=new OffscreenCanvas(swap?height:width,swap?width:height);
      const transforms={2:[-1,0,0,1,width,0],3:[-1,0,0,-1,width,height],4:[1,0,0,-1,0,height],
        5:[0,1,1,0,0,0],6:[0,1,-1,0,height,0],7:[0,-1,-1,0,height,width],8:[0,-1,1,0,0,width]};
      const out=output.getContext('2d');out.setTransform(...transforms[orientation]);out.drawImage(raw,0,0);
    }
    return await output.convertToBlob({type:'image/png'});
  }finally{raw.width=raw.height=0;if(output!==raw)output.width=output.height=0;}
}
async function tiff(buffer,maxPixels,maxPages){
  self.window=self; // UTIF checks optional window.UDOC for CMYK colour profiles.
  importScripts('image-codecs/UTIF.js');
  const ifds=UTIF.decode(buffer);
  if(ifds.some(ifd=>ifd.t50706||[32803,34892].includes(ifd.t262?.[0])))throw Error('此檔案含 RAW／DNG 感光資料，請先匯出 JPG／PNG。');
  const frames=ifds.filter(ifd=>ifd.t256&&ifd.t257&&!((ifd.t254?.[0]||0)&5)&&ifd.t255?.[0]!==2);
  if(!frames.length)throw Error('TIFF 找不到可讀取的頁面，請另存為 PNG 或 PDF。');
  if(frames.length>maxPages){const error=Error('TIFF 拆頁後超過本批剩餘頁數上限。');error.code='PAGE_LIMIT';throw error;}
  const pages=[];
  for(const frame of frames){
    const width=frame.t256[0],height=frame.t257[0];dimensions(width,height,maxPixels);
    const offsets=frame.t273||frame.t324||frame.t513,lengths=frame.t279||frame.t325||frame.t514;
    if(!offsets?.length||offsets.length!==lengths?.length||offsets.some((offset,i)=>offset<0||!lengths[i]||offset+lengths[i]>buffer.byteLength))throw Error('TIFF 像素資料不完整，請重新取得檔案或另存為 PNG／PDF。');
    // UTIF may silently produce black pixels for unsupported compression/colour modes.
    const compression=frame.t259?.[0]||1,colour=frame.t262?.[0]??2,bits=frame.t258||[1],samples=frame.t277?.[0]||bits.length;
    const depths={0:[1,4,8],1:[1,2,8,16],2:[8,16],3:[8],5:[8],6:[8]};
    if(![1,3,4,5,6,7,8,32773,32946,32809].includes(compression)||!depths[colour]?.includes(bits[0])||bits.some(b=>b!==bits[0])||(frame.t284?.[0]||1)!==1||frame.t339?.some(value=>value!==1)||(colour===2&&![3,4].includes(samples))||(colour===5&&![4,5].includes(samples))||(colour===6&&![6,7].includes(compression)))throw Error('此 TIFF 的壓縮或色彩格式不支援，請另存為 PNG 或 PDF。');
    UTIF.decodeImage(buffer,frame,ifds);
    if(!frame.data?.length)throw Error('TIFF 像素資料損毀，請另存為 PNG 或 PDF。');
    const rgba=UTIF.toRGBA8(frame);
    pages.push(await png(rgba,width,height,frame.t274?.[0]||1));delete frame.data;
  }
  return {pages,notice:''};
}
self.onmessage=async({data:{file,format,maxPages,maxPixels}})=>{
  try{
    if(format!=='tiff')throw Error('此背景轉換器僅支援 TIFF，請先另存為 JPG／PNG。');
    const buffer=await file.arrayBuffer();
    self.postMessage(await tiff(buffer,maxPixels,maxPages));
  }catch(error){self.postMessage({error:error.message||'圖片轉換失敗，請另存為 JPG／PNG。',code:error.code||''});}
};
