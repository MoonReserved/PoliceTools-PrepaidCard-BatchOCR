'use strict';
// Shared by the page and Service Worker so a ready indicator covers every dependency.
globalThis.OFFLINE_APP_VERSION='v8.2';
globalThis.OFFLINE_ASSETS=[
  './','index.html','styles.css','attribution.css','fonts/ui-tc.woff',
  'offline-assets.js','text-diff.js','app.js','ocr-worker.js','detection.js','pdf-source.js','sw.js','service-worker.js',
  'runtime/ort.wasm.min.js','runtime/ort-wasm-simd-threaded.mjs','runtime/ort-wasm-simd-threaded.wasm',
  'models/det5.onnx','models/small6.onnx','models/small6.dict.json',
  'pdfjs/pdf.min.mjs','pdfjs/pdf.worker.min.mjs','pdfjs/resources.json','pdfjs/resources.pack',
  'pdfjs/wasm/jbig2_nowasm_fallback.js','pdfjs/wasm/openjpeg_nowasm_fallback.js',
  'licenses/ASSET_SOURCES.txt','licenses/NOTO_FONT_OFL.txt','licenses/ONNX_RUNTIME_LICENSE.txt',
  'licenses/ONNX_RUNTIME_THIRD_PARTY_NOTICES.txt','licenses/PADDLEOCR_LICENSE.txt','licenses/RAPIDOCR_LICENSE.txt',
  'licenses/PDFJS_LICENSE.txt','licenses/PDFJS_THIRD_PARTY_LICENSES.txt','licenses/PDFJS_ASSET_SOURCES.txt'
];
