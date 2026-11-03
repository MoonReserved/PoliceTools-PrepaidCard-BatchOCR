'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const image=require('../docs/image-source.js');
const classify=(name,type,header='')=>image.classify({name,type},Buffer.from(header,'latin1'));
test('HEIF family accepts missing/wrong MIME and uppercase extensions',()=>{
  for(const ext of ['HEIC','heif','HIF','heics','heifs'])assert.equal(classify('photo.'+ext,''),'heif');
  assert.equal(classify('unknown','image/heif-sequence'),'heif');
  const header=Buffer.alloc(28);header.writeUInt32BE(28);header.write('ftypmif1',4);header.write('heic',16);
  assert.equal(image.classify({name:'wrong.jpg',type:'image/jpeg'},header),'heif');
  header.write('avif',20);assert.equal(image.classify({name:'wrong.heic'},header),'native');
});
test('content signatures take precedence over misleading extensions and generic MIME',()=>{
  for(const header of ['II*\0','MM\0*'])assert.equal(classify('photo.bin','application/octet-stream',header),'tiff');
  assert.equal(classify('photo.TIFF',''),'tiff');
  assert.equal(classify('photo','image/x-tiff'),'tiff');
  assert.equal(classify('photo.jpg','','II+\0'),'bigtiff');
  assert.equal(classify('photo.heic','','\xff\xd8\xff'),'native');
  assert.equal(classify('document.bin','','%PDF-1.7'),'pdf');
  for(const name of ['image.JFIF','image.jpe','image.svg','image.webp','image.avif','image.gif','image.bmp'])assert.equal(classify(name,''),'native');
});
test('RAW does not accidentally get interpreted as a regular TIFF',()=>{
  for(const name of ['a.DNG','a.nef','a.CR2','a.cr3','a.arw','a.raf','a.rw2'])assert.equal(classify(name,'image/tiff','II*\0'),'raw');
  assert.equal(classify('random.zip','','garbage'),'unknown');
});
test('invalid and oversized dimensions are rejected; existing 80 MP limit remains',()=>{
  image.checkSize(10000,8000);
  for(const dims of [[0,10],[10,0],[-1,10],[1.5,2],[10000,8001],[NaN,20],[Infinity,1]])assert.throws(()=>image.checkSize(...dims));
});
test('unsupported formats give actionable errors without a worker',async()=>{
  for(const [format,message] of [['raw',/RAW/],['bigtiff',/BigTIFF/],['unknown',/JPG／PNG/]])await assert.rejects(image.prepare({},format),message);
  await assert.rejects(image.prepare({},'native',{isCancelled:()=>true}),/取消/);
});
