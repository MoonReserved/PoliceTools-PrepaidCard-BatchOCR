'use strict';
// Display-only comparison. Candidate strings remain unchanged for adoption/export.
(() => {
  const MAX_GRAPHEMES = 512;
  const segmenter = typeof Intl?.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;

  function limitedSegments(text) {
    const result = [];
    const parts = segmenter ? segmenter.segment(text) : text;
    for (const part of parts) {
      result.push(segmenter ? part.segment : part);
      if (result.length > MAX_GRAPHEMES) return null;
    }
    return result;
  }
  function append(tokens, type, text, referenceText) {
    const previous = tokens[tokens.length - 1];
    if (previous?.type === type) {
      previous.text += text;
      previous.referenceText += referenceText;
    } else tokens.push({type, text, referenceText});
  }
  function previousCodePoint(text, end) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xDC00 && last <= 0xDFFF && end > 1) {
      const before = text.charCodeAt(end - 2);
      if (before >= 0xD800 && before <= 0xDBFF) return end - 2;
    }
    return end - 1;
  }
  // Linear fallback avoids allocating an unbounded edit-distance matrix.
  function coarseDiff(reference, candidate) {
    let start = 0, referenceEnd = reference.length, candidateEnd = candidate.length;
    while (start < referenceEnd && start < candidateEnd) {
      const point = reference.codePointAt(start);
      if (point !== candidate.codePointAt(start)) break;
      start += point > 0xFFFF ? 2 : 1;
    }
    while (referenceEnd > start && candidateEnd > start) {
      const ri = previousCodePoint(reference, referenceEnd);
      const ci = previousCodePoint(candidate, candidateEnd);
      if (ri < start || ci < start || reference.slice(ri, referenceEnd) !== candidate.slice(ci, candidateEnd)) break;
      referenceEnd = ri; candidateEnd = ci;
    }
    const tokens = [];
    if (start) append(tokens, 'equal', candidate.slice(0, start), reference.slice(0, start));
    const oldMiddle = reference.slice(start, referenceEnd), newMiddle = candidate.slice(start, candidateEnd);
    if (oldMiddle || newMiddle) append(tokens, oldMiddle ? (newMiddle ? 'replace' : 'delete') : 'insert', newMiddle, oldMiddle);
    if (candidateEnd < candidate.length) append(tokens, 'equal', candidate.slice(candidateEnd), reference.slice(referenceEnd));
    return {reference, candidate, tokens, changed: reference !== candidate, distance: null, fallback: true,
      note: '文字較長，差異以共同前後綴標示；請核對完整內容。'};
  }
  function diff(reference, candidate) {
    reference = String(reference ?? ''); candidate = String(candidate ?? '');
    if (reference === candidate) return {reference, candidate,
      tokens: reference ? [{type: 'equal', text: candidate, referenceText: reference}] : [],
      changed: false, distance: 0, fallback: false, note: ''};
    const a = limitedSegments(reference), b = limitedSegments(candidate);
    if (!a || !b) return coarseDiff(reference, candidate);
    const rows = a.length + 1, columns = b.length + 1;
    const costs = new Uint16Array(rows * columns);
    for (let i = 0; i < rows; i++) costs[i * columns + b.length] = a.length - i;
    for (let j = 0; j < columns; j++) costs[a.length * columns + j] = b.length - j;
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        const at = i * columns + j;
        costs[at] = a[i] === b[j] ? costs[at + columns + 1]
          : 1 + Math.min(costs[at + columns + 1], costs[at + columns], costs[at + 1]);
      }
    }
    const tokens = [];
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      const at = i * columns + j;
      if (i < a.length && j < b.length && a[i] === b[j]) {
        append(tokens, 'equal', b[j++], a[i++]);
      } else if (i < a.length && j < b.length && costs[at] === 1 + costs[at + columns + 1]) {
        // Prefer substitutions on a tie; repeated-character matches stay stable.
        append(tokens, 'replace', b[j++], a[i++]);
      } else if (i < a.length && costs[at] === 1 + costs[at + columns]) {
        append(tokens, 'delete', '', a[i++]);
      } else {
        append(tokens, 'insert', b[j++], '');
      }
    }
    return {reference, candidate, tokens, changed: true, distance: costs[0], fallback: false, note: ''};
  }
  function visibleDescription(text) {
    // Human-readable diagnostics only. Never substitute into the source string.
    const clipped = text.length > 80 ? text.slice(0, 80) + '…' : text;
    return clipped.replace(/ /g, '␠').replace(/\t/g, '⇥').replace(/\r/g, '␍').replace(/\n/g, '↵');
  }
  function render(container, reference, candidate) {
    if (!container?.ownerDocument || typeof container.replaceChildren !== 'function') {
      throw new TypeError('字元差異需要有效的顯示容器。');
    }
    const result = diff(reference, candidate), document = container.ownerDocument;
    const fragment = document.createDocumentFragment();
    for (const token of result.tokens) {
      if (token.type === 'equal') { fragment.append(document.createTextNode(token.text)); continue; }
      const span = document.createElement('span');
      span.dataset.diffType = token.type;
      if (token.type === 'delete') {
        span.className = 'ocr-diff-missing';
        const description = visibleDescription(token.referenceText);
        span.textContent = `〔缺 ${description}〕`;
        span.title = `預設辨識含有「${description}」，此候選缺少這些字元。`;
        span.setAttribute('aria-label', `相較預設辨識，缺少 ${description}`);
      } else {
        span.className = 'ocr-diff-change';
        span.textContent = token.text;
        const description = visibleDescription(token.text);
        span.title = token.type === 'insert' ? `此候選多出「${description}」。`
          : `預設辨識為「${visibleDescription(token.referenceText)}」，此候選為「${description}」。`;
      }
      fragment.append(span);
    }
    if (result.note) {
      const note = document.createElement('span');
      note.className = 'ocr-diff-note'; note.textContent = result.note;
      fragment.append(note);
    }
    container.replaceChildren(fragment);
    return result;
  }
  globalThis.OfflineTextDiff = Object.freeze({diff, render, maxGraphemes: MAX_GRAPHEMES});
})();
