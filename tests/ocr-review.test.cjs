'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const review = require('../docs/ocr-review.js');
const candidate = (text, scores = Array.from(text, () => .99)) => ({text, charConfidence: scores, confidence: .99});
const primary = (best, texts = Array(4).fill(best.text)) => ({best, candidates: texts.map(text => candidate(text))});

test('A single weak character triggers review despite a high overall score', () => {
  const r = review.analyze(primary(candidate('AB1D', [.999, .999, .5494, .999])));
  assert(r.needsReview); assert(!r.hasDisagreement);
  assert.deepEqual(r.lowCharacters, [{position:3,character:'1',score:.5494,threshold:.8,low:true}]);
});
test('Threshold is strict, and lower scores in non-selected candidates do not cause noise', () => {
  const p = primary(candidate('AB', [.8, .91]));
  p.candidates[0].charConfidence = [.2, .3];
  assert(!review.analyze(p).needsReview);
  p.best.charConfidence[0] = .79999;
  assert(review.analyze(p).needsReview);
});
test('Any differing candidate independently triggers review, including insertions and missing text', () => {
  for (const other of ['AB1D', 'ABD', 'ABCCD', '']) {
    const r = review.analyze(primary(candidate('ABCD'), ['ABCD', 'ABCD', other, 'ABCD']));
    assert(r.needsReview); assert(r.hasDisagreement); assert.equal(r.lowCharacters.length, 0);
    assert.equal(r.differingCandidates.length, 1); assert.equal(r.candidateCount, 4);
  }
});
test('Scores and character-specific thresholds are independent of the overall average', () => {
  const p = primary(candidate('I1', [.83, .83])); p.best.confidence = .01;
  assert.equal(review.analyze(p).lowCharacters.length, 0);
  const r = review.analyze(p, {characterThresholds:{I:.85}});
  assert.deepEqual(r.lowCharacters.map(x => x.character), ['I']);
  assert.equal(review.analyze(p, {threshold:.7}).lowCharacters.length, 0);
  assert.equal(review.analyze(primary(candidate('0',[0])), {threshold:0}).lowCharacters.length, 0);
});
test('Missing or invalid scores never borrow the overall score or shift character positions', () => {
  for (const scores of [undefined, [], [.5], [.5, .6, .7]]) {
    const r = review.analyze(primary({text:'I1',confidence:.2,charConfidence:scores}));
    assert(r.needsReview); assert.equal(r.lowCharacters.length, 0); assert(r.letters.every(x => x.score === null));
  }
  for (const score of [NaN, Infinity, -.1, 1.1, null, '0.2']) {
    const r = review.analyze(primary(candidate('I1', [score, .9])));
    assert.equal(r.letters[0].score, null); assert.equal(r.letters[1].score, .9);
  }
  assert(!review.analyze(null).needsReview);
});
test('Unicode code points align with decoder output; inputs remain immutable', () => {
  const p = primary(candidate('A𠮷I', [.99, .3, .9])), before = structuredClone(p);
  assert.equal(review.analyze(p).lowCharacters[0].position, 2);
  assert.deepEqual(p, before);
});
test('Invalid thresholds fail explicitly', () => {
  for (const threshold of [-1, 2, NaN, Infinity, '0.8']) assert.throws(() => review.analyze(null,{threshold}));
  assert.throws(() => review.analyze(null,{characterThresholds:{I:2}}));
});
test('Each O, 0, I and 1 triggers review even with perfect scores and identical candidates', () => {
  for (const character of 'O0I1oｏＯ０iｉＩ１') {
    const p = primary(candidate(`AB${character}CD`, [1, 1, 1, 1, 1])), before = structuredClone(p);
    const r = review.analyze(p);
    assert(r.needsReview); assert(!r.hasDisagreement); assert.equal(r.lowCharacters.length, 0);
    assert.deepEqual(r.ambiguousCharacters, [{position:3, character}]);
    assert.equal(r.text, p.best.text); assert.deepEqual(p, before);
  }
});
test('Ambiguity is independent of available scores and preserves Unicode positions', () => {
  assert.deepEqual(review.findAmbiguousCharacters('𠮷O-0 I\n1'), [
    {position:2,character:'O'}, {position:4,character:'0'}, {position:6,character:'I'}, {position:8,character:'1'}
  ]);
  for (const text of ['O', '0', 'I', '1']) assert(review.analyze({best:{text}}).needsReview);
  for (const text of ['', 'ABCD23456789', 'QDLB8', null, undefined]) {
    assert.deepEqual(review.findAmbiguousCharacters(text), []);
    assert(!review.analyze(primary(candidate(text || ''))).needsReview);
  }
});
test('CTC keeps one score per emitted character, including repeated characters separated by blank', () => {
  const context = vm.createContext({importScripts(){},ort:{env:{wasm:{}}},self:{location:{href:'http://localhost/ocr-worker.js'}},URL});
  vm.runInContext(fs.readFileSync(require.resolve('../docs/ocr-worker.js'),'utf8'),context);
  const result = context.decode({dims:[1,6,4],data:new Float32Array([
    .01,.9,.05,.04, .01,.8,.1,.09, .99,.003,.003,.004,
    .01,.85,.1,.04, .01,.03,.55,.41, .01,.04,.1,.85
  ])}, ['blank','A','1','𠮷']);
  assert.equal(result.text,'AA1𠮷'); assert.equal(result.charConfidence.length,4);
  assert(Math.abs(result.charConfidence[2]-.55)<1e-6);
  assert.equal(result.confidence,result.charConfidence.reduce((a,b)=>a+b,0)/4);
});
