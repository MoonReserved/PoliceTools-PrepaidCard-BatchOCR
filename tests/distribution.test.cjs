'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../docs');
const globals={};vm.runInNewContext(fs.readFileSync(path.join(root,'offline-assets.js'),'utf8'),globals);
test('every offline asset and local attribution link exists after retiring HEVC',()=>{
  for(const asset of globals.OFFLINE_ASSETS)assert(fs.existsSync(path.join(root,asset==='./'?'index.html':asset)),asset);
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  for(const match of html.matchAll(/href="((?:licenses|sources)\/[^"#]+)"/g))assert(fs.existsSync(path.join(root,match[1])),match[1]);
  assert(globals.OFFLINE_ASSETS.includes('licenses/THIRD_PARTY_NOTICES.txt'));
  assert.match(html,/HEIC.*原生/);
});
test('release files and offline manifest exclude HEVC implementations and archives',()=>{
  for(const name of ['image-codecs/libheif-bundle.js','sources/image-codecs-source.zip','licenses/LIBHEIF_LICENSE.txt','licenses/LIBDE265_LICENSE.txt']){
    assert(!fs.existsSync(path.join(root,name)),name);assert(!globals.OFFLINE_ASSETS.includes(name),name);
  }
  const worker=fs.readFileSync(path.join(root,'image-decoder-worker.js'),'utf8');
  assert.doesNotMatch(worker,/libheif|libde265|HeifDecoder/);
  assert.match(worker,/format!=='tiff'/);
  assert(!fs.readdirSync(path.join(__dirname,'fixtures/images')).some(name=>/\.hei[cf]$/i.test(name)));
});
test('copyright supplements retain nested decoder, font and model attribution',()=>{
  const notices=fs.readFileSync(path.join(root,'licenses/THIRD_PARTY_NOTICES.txt'),'utf8');
  for(const pattern of [/Copyright 2014 Mozilla Foundation/,/Copyright \(c\) 2017 Photopea/,/Copyright \(c\) 2018 Photopea/,/2014-2021 Adobe/,/Baidu/,/RapidOCR Authors/])assert.match(notices,pattern);
  for(const license of ['UTIF_LICENSE.txt','PDFJS_LICENSE.txt','NOTO_FONT_OFL.txt','PADDLEOCR_LICENSE.txt','RAPIDOCR_LICENSE.txt'])assert(globals.OFFLINE_ASSETS.includes('licenses/'+license));
});
