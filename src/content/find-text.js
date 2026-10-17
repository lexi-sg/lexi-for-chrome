// src/content/find-text.js
//
// find_text: searches the page's FULL rendered text for a phrase or quote —
// unlike read_page, which caps long pages and drops their middle — and reports
// where each match sits: a short snippet, the nearest heading, the numbered
// paragraph and page marker in effect (when the page has them), and an element
// ref the agent can scroll to. Only that summary leaves the page, never the
// page text itself.
//
// Matching never guesses:
//   normalize -> exact (within one paragraph) -> span (across two neighbouring
//   paragraphs) -> fuzzy (>= 0.90 similarity) -> not_found
//
// CLASSIC SCRIPT — no `import`/`export`. Injected after dom-index.js (it asks
// window.__lexi.domIndex.refFor for refs). The matching functions
// (normalizeWithMap, buildParas, matchQuote, describeHit) touch no DOM, so the
// test suite runs them under node:vm.
//
// window.__lexi.findText.findText(query, maxResults) -> {match, score, total, results}

(function () {
  var root = typeof window !== 'undefined' ? window : globalThis;
  if (root.__lexi && root.__lexi.findText) {
    return;
  }
  root.__lexi = root.__lexi || {};

  var FUZZY_THRESHOLD = 0.9;
  var MIN_FUZZY_CHARS = 20;
  var MAX_QUERY_CHARS = 2000;
  var FUZZY_CANDIDATES = 6;
  var MIN_WORD_OVERLAP = 0.5;
  var DEFAULT_RESULTS = 5;
  var MAX_RESULTS = 20;
  var MAX_EXACT_SCAN = 200;
  var SNIPPET_BEFORE = 80;
  var SNIPPET_AFTER = 160;

  // ---------------------------------------------------------------------
  // Normalization (keeps a map from each normalized char to its raw index)
  // ---------------------------------------------------------------------

  // Curly quotes, primes and dashes fold to their ASCII forms; the ellipsis
  // character becomes "..." so it splits a query the same way three dots do.
  var CHAR_FOLD = {
    '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '`': "'",
    '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '«': '"', '»': '"',
    '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
    '…': '...',
  };

  // Dropped before matching: superscript footnote digits, bracketed footnote
  // refs like [12], asterisks, and hyphens between letters (so a line-break
  // "consti- tution" and "self-defence" compare the same on both sides).
  var DROP_PATTERNS = [
    /[¹²³⁰-⁹]+/g,
    /\[\d{1,3}\]/g,
    /\*+/g,
    /(?<=\p{L})[-‐‑­]\s*(?=\p{L})/gu,
  ];

  function normalizeWithMap(raw) {
    raw = String(raw == null ? '' : raw);
    var drop = new Uint8Array(raw.length);
    for (var p = 0; p < DROP_PATTERNS.length; p++) {
      var re = DROP_PATTERNS[p];
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(raw)) !== null) {
        for (var k = m.index; k < m.index + m[0].length; k++) drop[k] = 1;
        if (m[0].length === 0) re.lastIndex += 1;
      }
    }
    var out = [];
    var map = [];
    var prevSpace = true;
    for (var i = 0; i < raw.length; i++) {
      if (drop[i]) continue;
      var ch = raw[i];
      if (/\s/.test(ch)) {
        if (!prevSpace) {
          out.push(' ');
          map.push(i);
          prevSpace = true;
        }
        continue;
      }
      var folded = CHAR_FOLD[ch] || ch.toLowerCase();
      for (var j = 0; j < folded.length; j++) {
        out.push(folded[j]);
        map.push(i);
      }
      prevSpace = false;
    }
    if (out.length && out[out.length - 1] === ' ') {
      out.pop();
      map.pop();
    }
    return { text: out.join(''), map: map };
  }

  // A query split on ellipses ("...", ". . .", "[...]"), each fragment
  // trimmed of the quote marks and edge punctuation people add or drop.
  function queryFragments(query) {
    var q = normalizeWithMap(String(query || '').slice(0, MAX_QUERY_CHARS)).text;
    return q
      .split(/\s*\[?\s*(?:\.\s?){3,}\]?\s*/)
      .map(function (f) {
        return f.replace(/^[\s"'.,;:!?()]+|[\s"'.,;:!?()]+$/g, '');
      })
      .filter(function (f) {
        return f.length > 0;
      });
  }

  // ---------------------------------------------------------------------
  // Lines -> paragraphs (numbered paragraph and page-marker detection)
  // ---------------------------------------------------------------------

  // A numbered-paragraph marker at the start of a line: "12.", "(12)", "12)",
  // "[12]", "¶ 12", "Para 12", or a bare number ("18    Justice …", "100 The
  // …": text taken from court PDFs, where the number sits in its own column).
  // The capture group that matched is its style.
  var PARA_MARKER_RE =
    /^\s*(?:(\d{1,4})\.(?=\s|$)|\((\d{1,4})\)(?=\s|$)|(\d{1,4})\)(?=\s|$)|\[(\d{1,4})\](?=\s|$)|(?:¶|para(?:graph)?\.?)\s*(\d{1,4})\b\.?|(\d{1,4})(?=[ \t\u00a0]+\S))\s*/i;
  var MARKER_STYLES = 6;
  var BARE_STYLE = 6;
  // A bare number set off by a run of spaces or a tab is a marker as it
  // stands; one followed by a single space only when a sentence starts after
  // it ("100 The …", not a wrapped line's "21 of the Constitution").
  var WIDE_BARE_RE = /^\s*\d{1,4}(?:[ \u00a0]{2,}|\t)/;
  var SENTENCE_START_RE = /^[A-Z“"‘'([]/;

  // "(1970) 1 SCC 248", "[1950] SCR 88": a year opening a citation (footnote
  // lines in PDF-derived text) is not a paragraph number.
  var CITATION_AFTER_YEAR_RE = /^(?:\d|[A-Z]{2,}\b)/;

  function isCitationYear(n, rest) {
    return n >= 1800 && n <= 2099 && CITATION_AFTER_YEAR_RE.test(rest);
  }

  // PDF-derived text keeps a footnote's reference glued to the word before it
  // ("…recognized rules and principles.232", "Union of India128"); the
  // footnote's body is the next line that starts with that number, within
  // about a printed page.
  var GLUED_REF_RE = /[A-Za-z]{4}[.,;:”"’')\]]?(\d{1,4})(?!\d)/g;
  var FOOTNOTE_LOOKBACK = 4000;
  // A footnote and the paragraph that shares its number sit within this many
  // characters when footnote numbering still runs close to the paragraphs'.
  var FOOTNOTE_TWIN_RANGE = 2 * FOOTNOTE_LOOKBACK;

  function noteGluedRefs(text, at, pending) {
    GLUED_REF_RE.lastIndex = 0;
    var m;
    while ((m = GLUED_REF_RE.exec(text)) !== null) pending.set(Number(m[1]), at + m.index);
  }

  /** True when `n` answers a glued reference made just before; uses it up. */
  function takeFootnoteRef(n, at, pending) {
    var refAt = pending.get(n);
    if (refAt === undefined) return false;
    pending.delete(n);
    return at - refAt <= FOOTNOTE_LOOKBACK;
  }

  // Reporter page markers: bracketed inline ("[*345]", "[Page 345]", "[p. 345]")
  // or a line that is only the marker ("Page 345", "Page No. 345").
  var PAGE_MARK_RE = /\[\s*(?:\*\s*|p(?:age|g)?\.?\s*)(\d{1,5})\s*\]/gi;
  var PAGE_LINE_RE = /^\s*-?\s*(?:page|pg\.?|p\.)\s*(?:no\.?\s*)?[:-]?\s*(\d{1,5})\s*-?\s*$/i;

  // Most chains a document may have (headnotes 1-5, the body 1-40, then each
  // separate opinion of a larger bench restarting at 1, …).
  var MAX_CHAINS = 30;
  var MAX_ROUNDS = 80;
  // A numbering may skip at most this many numbers between two markers.
  var MAX_PARA_GAP = 3;
  // A later chain restarts the numbering (starts at most here) or carries on
  // a neighbouring chain, skipping at most MAX_RESUME_GAP numbers.
  var MAX_RESTART = MAX_PARA_GAP + 1;
  var MAX_RESUME_GAP = 10;

  function stripPageMarks(text, marks) {
    var cuts = [];
    PAGE_MARK_RE.lastIndex = 0;
    var m;
    while ((m = PAGE_MARK_RE.exec(text)) !== null) {
      cuts.push({ start: m.index, end: m.index + m[0].length, page: m[1] });
    }
    if (!cuts.length) return { text: text, marks: marks.slice() };
    var out = '';
    var last = 0;
    var found = [];
    for (var i = 0; i < cuts.length; i++) {
      out += text.slice(last, cuts[i].start);
      found.push({ at: out.length, page: cuts[i].page });
      last = cuts[i].end;
    }
    out += text.slice(last);
    function shift(pos) {
      var removed = 0;
      for (var c = 0; c < cuts.length; c++) {
        if (cuts[c].end <= pos) removed += cuts[c].end - cuts[c].start;
        else if (cuts[c].start < pos) removed += pos - cuts[c].start;
      }
      return pos - removed;
    }
    var shifted = marks.map(function (mk) {
      return { at: shift(mk.at), page: mk.page };
    });
    return {
      text: out,
      marks: shifted.concat(found).sort(function (a, b) {
        return a.at - b.at;
      }),
    };
  }

  function markerStyle(m) {
    for (var g = 1; g <= MARKER_STYLES; g++) if (m[g] !== undefined) return g;
    return 0;
  }

  // A footnote line that shares its number with a paragraph start close by
  // (footnotes 4-5 printed between paragraphs 3 and 4) is never a paragraph.
  function dropShadowedFootnotes(cands) {
    return cands.filter(function (c) {
      if (!c.footRef) return true;
      return !cands.some(function (o) {
        return !o.footRef && o.n === c.n && o.style === c.style && Math.abs(o.at - c.at) <= FOOTNOTE_TWIN_RANGE;
      });
    });
  }

  // A chain whose markers were mostly cited earlier as glued references is
  // the footnote numbering of a PDF-derived text, not its paragraphs.
  function isFootnoteChain(members) {
    var refs = members.filter(function (c) { return c.footRef; }).length;
    return refs * 2 > members.length;
  }

  // After the first chain, another must restart the numbering (a separate
  // opinion, the headnotes) or continue a chain beside it: a run starting
  // at 229 straight after paragraph 99 is something else.
  function fitsNumbering(members, chains) {
    if (!chains.length || members[0].n <= MAX_RESTART) return true;
    var first = members[0];
    var last = members[members.length - 1];
    var before = null;
    var after = null;
    for (var i = 0; i < chains.length; i++) {
      var c = chains[i];
      if (c.lastRow < first.row && (!before || c.lastRow > before.lastRow)) before = c;
      if (c.firstRow > last.row && (!after || c.firstRow < after.firstRow)) after = c;
    }
    var resumes = before && first.n - before.lastN >= 1 && first.n - before.lastN <= MAX_RESUME_GAP;
    var leadsInto = after && after.firstN - last.n >= 1 && after.firstN - last.n <= MAX_RESUME_GAP;
    return !!(resumes || leadsInto);
  }

  // Picks the numbered-paragraph chains: runs of same-style markers whose
  // numbers climb by 1..MAX_PARA_GAP. The longest run wins first, then any
  // other run of 3+ that lies wholly outside the runs already taken — so a
  // quoted statute's "(1)", "(2)" or a short list inside paragraph 15 never
  // reads as a paragraph number. Footnote runs and runs that fit no
  // numbering are dropped. Returns Map(rowIndex -> candidate).
  function pickParaChains(cands) {
    var accepted = new Map();
    var chains = [];
    var used = new Set();
    function insideChain(row) {
      for (var s = 0; s < chains.length; s++) {
        if (row >= chains[s].firstRow && row <= chains[s].lastRow) return true;
      }
      return false;
    }
    for (var round = 0; round < MAX_ROUNDS && chains.length < MAX_CHAINS; round++) {
      var live = cands.filter(function (c) {
        return !used.has(c) && !insideChain(c.row);
      });
      // Longest run ending at each candidate; on a tie the nearest
      // predecessor wins, which keeps a run inside its own opinion.
      var len = [];
      var prev = [];
      var best = -1;
      for (var i = 0; i < live.length; i++) {
        len[i] = 1;
        prev[i] = -1;
        for (var j = i - 1; j >= 0; j--) {
          if (live[j].style !== live[i].style) continue;
          var d = live[i].n - live[j].n;
          if (d >= 1 && d <= MAX_PARA_GAP && len[j] + 1 > len[i]) {
            len[i] = len[j] + 1;
            prev[i] = j;
          }
        }
        if (best < 0 || len[i] > len[best]) best = i;
      }
      if (best < 0) break;
      var members = [];
      for (var k = best; k >= 0; k = prev[k]) members.unshift(live[k]);
      var minLen = chains.length ? 3 : 2;
      if (members.length < minLen) break;
      if (isFootnoteChain(members)) {
        members.forEach(function (c) {
          used.add(c);
        });
        continue;
      }
      // Footnotes printed just before or after the run (paragraphs 1-3, then
      // footnotes 4-6) are not part of it.
      while (members.length && members[0].footRef) members.shift();
      while (members.length && members[members.length - 1].footRef) members.pop();
      members.forEach(function (c) {
        used.add(c);
      });
      if (members.length < minLen || !fitsNumbering(members, chains)) continue;
      members.forEach(function (c) {
        accepted.set(c.row, c);
      });
      chains.push({
        firstRow: members[0].row,
        lastRow: members[members.length - 1].row,
        firstN: members[0].n,
        lastN: members[members.length - 1].n,
      });
    }
    return accepted;
  }

  // lines: [{text, marks?:[{at,page}], heading?, isHeading?, el?}] in document order.
  // Returns paragraphs: [{label, text, marks, pageAtStart, starts:[{at, heading, el}]}].
  // Lines before the first numbered paragraph (titles, headnotes without
  // numbers, ordinary unnumbered pages) collect into unlabelled paragraphs.
  function buildParas(lines) {
    var rows = [];
    var cands = [];
    var pendingRefs = new Map(); // footnote number -> where its glued reference sits
    var offset = 0; // characters before the current line
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i] || {};
      var raw = String(line.text || '');
      var standalone = PAGE_LINE_RE.exec(raw);
      if (standalone) {
        rows.push({ text: '', marks: [{ at: 0, page: standalone[1] }], line: line });
        continue;
      }
      var stripped = stripPageMarks(raw, line.marks || []);
      rows.push({ text: stripped.text, marks: stripped.marks, line: line });
      var m = PARA_MARKER_RE.exec(stripped.text);
      if (m) {
        var style = markerStyle(m);
        var n = Number(m[style]);
        var rest = stripped.text.slice(m[0].length);
        var plausible =
          !isCitationYear(n, rest) &&
          (style !== BARE_STYLE || WIDE_BARE_RE.test(stripped.text) || SENTENCE_START_RE.test(rest));
        if (plausible) {
          cands.push({
            row: rows.length - 1,
            at: offset,
            n: n,
            style: style,
            len: m[0].length,
            footRef: takeFootnoteRef(n, offset, pendingRefs),
          });
        }
      }
      noteGluedRefs(stripped.text, offset, pendingRefs);
      offset += stripped.text.length + 1;
    }

    var accepted = pickParaChains(dropShadowedFootnotes(cands));
    var paras = [];
    var cur = null;
    var page = null;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var text = row.text;
      var marker = accepted.get(r);
      var cut = 0;
      if (marker) {
        cut = marker.len;
        text = text.slice(cut);
        cur = { label: String(marker.n), text: '', marks: [], pageAtStart: page, starts: [] };
        paras.push(cur);
      } else if (!cur || (row.line.isHeading && text.trim())) {
        // A heading closes the numbered paragraph before it.
        cur = { label: null, text: '', marks: [], pageAtStart: page, starts: [] };
        paras.push(cur);
      }
      var base = cur.text.length ? cur.text.length + 1 : 0;
      if (text.trim()) {
        cur.text = cur.text.length ? cur.text + ' ' + text : text;
        cur.starts.push({ at: base, heading: row.line.heading || null, el: row.line.el || null });
      }
      for (var k = 0; k < row.marks.length; k++) {
        cur.marks.push({ at: base + Math.max(0, row.marks[k].at - cut), page: row.marks[k].page });
        page = row.marks[k].page;
      }
    }
    return paras.filter(function (p) {
      return p.text.trim().length > 0;
    });
  }

  // ---------------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------------

  // Finds every fragment in order, starting at `from`. Returns the
  // normalized [start, end) of the whole run, or start -1.
  function findFragments(text, frags, from) {
    var start = text.indexOf(frags[0], from);
    if (start < 0) return { start: -1, end: -1 };
    var pos = start + frags[0].length;
    for (var i = 1; i < frags.length; i++) {
      var at = text.indexOf(frags[i], pos);
      if (at < 0) return { start: -1, end: -1 };
      pos = at + frags[i].length;
    }
    return { start: start, end: pos };
  }

  function rawSpan(norm, start, end) {
    return { start: norm.map[start], end: norm.map[end - 1] + 1 };
  }

  function wordsOf(text) {
    return text.match(/[\p{L}\p{N}]{3,}/gu) || [];
  }

  // Best approximate occurrence of `pattern` anywhere inside `text`
  // (Sellers' edit-distance alignment: free start and end in the text).
  function bestWindow(pattern, text) {
    var m = pattern.length;
    var prev = new Int32Array(m + 1);
    var cur = new Int32Array(m + 1);
    for (var i = 0; i <= m; i++) prev[i] = i;
    var best = m;
    var bestEnd = 0;
    for (var j = 1; j <= text.length; j++) {
      cur[0] = 0;
      var tc = text.charCodeAt(j - 1);
      for (var r = 1; r <= m; r++) {
        var v = prev[r - 1] + (pattern.charCodeAt(r - 1) === tc ? 0 : 1);
        if (prev[r] + 1 < v) v = prev[r] + 1;
        if (cur[r - 1] + 1 < v) v = cur[r - 1] + 1;
        cur[r] = v;
      }
      if (cur[m] < best) {
        best = cur[m];
        bestEnd = j;
      }
      var tmp = prev;
      prev = cur;
      cur = tmp;
    }
    return { score: m ? 1 - best / m : 0, end: bestEnd };
  }

  // Narrows a long text to the stretch (about 4x the fragment) holding the
  // most distinct query words, so the alignment stays cheap on huge pages.
  function focusWindow(text, frag) {
    var span = frag.length * 4;
    if (text.length <= span * 1.5) return { offset: 0, text: text };
    var want = new Set(wordsOf(frag));
    var hits = [];
    var re = /[\p{L}\p{N}]{3,}/gu;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (want.has(m[0])) hits.push({ at: m.index, word: m[0] });
    }
    if (!hits.length) return { offset: 0, text: text.slice(0, span) };
    var bestAt = hits[0].at;
    var bestCount = 0;
    var counts = new Map();
    var lo = 0;
    for (var hi = 0; hi < hits.length; hi++) {
      counts.set(hits[hi].word, (counts.get(hits[hi].word) || 0) + 1);
      while (hits[hi].at - hits[lo].at > frag.length) {
        var w = hits[lo].word;
        counts.set(w, counts.get(w) - 1);
        if (!counts.get(w)) counts.delete(w);
        lo += 1;
      }
      if (counts.size > bestCount) {
        bestCount = counts.size;
        bestAt = hits[lo].at;
      }
    }
    var offset = Math.max(0, bestAt - frag.length);
    return { offset: offset, text: text.slice(offset, offset + span) };
  }

  function fuzzyInUnit(norm, frags) {
    var score = 1;
    var start = -1;
    var end = 0;
    for (var f = 0; f < frags.length; f++) {
      var win = focusWindow(norm.text, frags[f]);
      var hit = bestWindow(frags[f], win.text);
      if (hit.score < score) score = hit.score;
      var fragEnd = win.offset + hit.end;
      if (f === 0) start = Math.max(0, fragEnd - frags[f].length);
      end = Math.max(end, fragEnd);
    }
    return { score: score, start: start, end: Math.max(end, start + 1) };
  }

  function exactHits(paras, norms, frags) {
    var hits = [];
    for (var i = 0; i < paras.length && hits.length < MAX_EXACT_SCAN; i++) {
      var from = 0;
      while (hits.length < MAX_EXACT_SCAN) {
        var at = findFragments(norms[i].text, frags, from);
        if (at.start < 0) break;
        var span = rawSpan(norms[i], at.start, at.end);
        hits.push({ para: i, endPara: i, start: span.start, end: span.end, score: 1 });
        from = at.start + 1;
      }
    }
    return hits;
  }

  function spanHits(paras, frags) {
    var hits = [];
    for (var i = 0; i + 1 < paras.length; i++) {
      var a = paras[i].text;
      var joined = normalizeWithMap(a + ' ' + paras[i + 1].text);
      var at = findFragments(joined.text, frags, 0);
      if (at.start < 0) continue;
      var span = rawSpan(joined, at.start, at.end);
      if (span.start < a.length && span.end > a.length) {
        hits.push({ para: i, endPara: i + 1, start: span.start, end: span.end, score: 1 });
      }
    }
    return hits;
  }

  function fuzzyHit(paras, norms, frags) {
    var qWords = Array.from(new Set(wordsOf(frags.join(' '))));
    if (!qWords.length) return null;
    var sets = norms.map(function (n) {
      return new Set(wordsOf(n.text));
    });
    function overlap(units) {
      var found = 0;
      for (var w = 0; w < qWords.length; w++) {
        if (units.some(function (u) { return sets[u].has(qWords[w]); })) found += 1;
      }
      return found / qWords.length;
    }
    var cands = [];
    for (var i = 0; i < paras.length; i++) {
      cands.push({ units: [i], overlap: overlap([i]) });
      if (i + 1 < paras.length) cands.push({ units: [i, i + 1], overlap: overlap([i, i + 1]) });
    }
    cands = cands
      .filter(function (c) { return c.overlap >= MIN_WORD_OVERLAP; })
      .sort(function (a, b) { return b.overlap - a.overlap || a.units.length - b.units.length; })
      .slice(0, FUZZY_CANDIDATES);

    var best = null;
    for (var c = 0; c < cands.length; c++) {
      var units = cands[c].units;
      var a = paras[units[0]].text;
      var raw = units.length === 1 ? a : a + ' ' + paras[units[1]].text;
      var norm = units.length === 1 ? norms[units[0]] : normalizeWithMap(raw);
      var hit = fuzzyInUnit(norm, frags);
      var better = !best || hit.score > best.score || (hit.score === best.score && units.length < best.units.length);
      if (better) best = { units: units, score: hit.score, norm: norm, start: hit.start, end: hit.end, aLen: a.length };
    }
    if (!best) return null;
    var span = rawSpan(best.norm, best.start, Math.min(best.end, best.norm.text.length));
    var hit2 = { para: best.units[0], endPara: best.units[0], start: span.start, end: span.end, score: best.score };
    if (best.units.length === 2) {
      if (span.start >= best.aLen) {
        hit2.para = hit2.endPara = best.units[1];
        hit2.start -= best.aLen + 1;
        hit2.end -= best.aLen + 1;
      } else if (span.end > best.aLen) {
        hit2.endPara = best.units[1];
      }
    }
    return hit2;
  }

  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  // paras from buildParas; returns {match, score, total, hits:[{para, endPara, start, end, score}]}
  // where start/end are raw offsets into paras[para].text (a span runs on
  // into paras[endPara]).
  function matchQuote(paras, query) {
    var frags = queryFragments(query);
    if (!frags.length) return { match: 'not_found', score: 0, total: 0, hits: [] };
    var norms = paras.map(function (p) { return normalizeWithMap(p.text); });

    var exact = exactHits(paras, norms, frags);
    if (exact.length) return { match: 'exact', score: 1, total: exact.length, hits: exact };

    var span = spanHits(paras, frags);
    if (span.length) return { match: 'span', score: 1, total: span.length, hits: span };

    if (frags.join(' ').length < MIN_FUZZY_CHARS) return { match: 'not_found', score: 0, total: 0, hits: [] };
    var fuzzy = fuzzyHit(paras, norms, frags);
    if (fuzzy && fuzzy.score >= FUZZY_THRESHOLD) {
      return { match: 'fuzzy', score: round2(fuzzy.score), total: 1, hits: [fuzzy] };
    }
    return { match: 'not_found', score: fuzzy ? round2(fuzzy.score) : 0, total: 0, hits: [] };
  }

  function collapse(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function pageAt(para, pos) {
    var page = para.pageAtStart;
    for (var i = 0; i < para.marks.length; i++) {
      if (para.marks[i].at <= pos) page = para.marks[i].page;
    }
    return page || null;
  }

  function lineAt(para, pos) {
    var line = para.starts[0] || {};
    for (var i = 0; i < para.starts.length; i++) {
      if (para.starts[i].at <= pos) line = para.starts[i];
    }
    return line;
  }

  // A hit as the agent sees it: a short snippet around the match plus where
  // it sits. `el` is the block element holding the match start (DOM only).
  function describeHit(paras, hit) {
    var p = paras[hit.para];
    var text = hit.endPara !== hit.para ? p.text + ' ' + paras[hit.endPara].text : p.text;
    var matchLen = hit.end - hit.start;
    var from = Math.max(0, hit.start - SNIPPET_BEFORE);
    var to = Math.min(text.length, hit.start + Math.max(matchLen, 0) + SNIPPET_BEFORE);
    if (to - from > SNIPPET_BEFORE + SNIPPET_AFTER) to = from + SNIPPET_BEFORE + SNIPPET_AFTER;
    var snippet = (from > 0 ? '…' : '') + collapse(text.slice(from, to)) + (to < text.length ? '…' : '');
    var endLabel = paras[hit.endPara].label;
    var label = p.label && endLabel && hit.endPara !== hit.para ? p.label + '-' + endLabel : p.label;
    var line = lineAt(p, hit.start);
    return {
      snippet: snippet,
      para: label || null,
      page: pageAt(p, hit.start),
      heading: line.heading || null,
      el: line.el || null,
    };
  }

  // ---------------------------------------------------------------------
  // DOM -> lines (live page, no cloning, so matches map back to elements)
  // ---------------------------------------------------------------------

  var SKIP_TAGS = {
    script: 1, style: 1, noscript: 1, template: 1, svg: 1, iframe: 1, object: 1, canvas: 1,
    video: 1, audio: 1, input: 1, textarea: 1, select: 1, option: 1, head: 1,
  };
  var INLINE_DISPLAY_RE = /^(inline|inline-block|inline-flex|inline-grid|contents|ruby|ruby-text)$/;
  var FOOTNOTE_SUP_RE = /^[\s\d*†‡§,[\]()-]+$/;
  var NUMBER_ONLY_RE = /^\s*\[?\s*\*?\s*(?:page|pg\.?|p\.)?\s*(?:no\.?)?\s*:?\s*(\d{1,5})\s*\.?\]?\s*$/i;
  var OVERLAY_HOST_ID = 'lexi-overlay-host';
  // Where a text node breaks into lines. In pre/pre-wrap blocks every newline
  // shows; elsewhere only a blank line or a form feed counts — the trace a
  // court PDF's text leaves between paragraphs it packed into one element
  // ("…Sharma\n\n\n8   A Bench…"), where the number starts the next line.
  var PRESERVED_NEWLINES_RE = /^(pre|pre-wrap|pre-line|break-spaces)$/;
  var LINE_BREAK_RE = /\r?\n|\f/;
  var BLANK_LINE_RE = /\n[ \t\u00a0]*\n|\f/;

  function hintOf(el) {
    return String(el.id || '') + ' ' + String(typeof el.className === 'string' ? el.className : '');
  }

  // Elements a reporter uses for its own page breaks / paragraph numbers,
  // e.g. <span class="pagebreak">345</span> or <span class="paranum">12</span>.
  // Links, buttons and list items with "page" classes are pagination, not
  // page markers.
  function pageMarkerOf(el) {
    if (!/page|pg/i.test(hintOf(el)) || el.children.length) return null;
    if (/^(a|button|li)$/.test(el.localName) || el.closest('nav, [role="navigation"]')) return null;
    var m = NUMBER_ONLY_RE.exec(el.textContent || '');
    return m ? m[1] : null;
  }

  function paraNumberOf(el) {
    if (!/para/i.test(hintOf(el)) || el.children.length) return null;
    var m = /^\s*[[(]?(\d{1,4})[.)\]]?\s*$/.exec(el.textContent || '');
    return m ? m[1] : null;
  }

  function collectLines(rootEl) {
    var lines = [];
    var cur = null;
    var heading = null;
    var inHeading = 0;

    function ensure(el) {
      if (!cur) cur = { text: '', marks: [], heading: heading, isHeading: inHeading > 0, el: el };
    }
    function flush() {
      if (cur && (cur.text.trim() || cur.marks.length)) lines.push(cur);
      cur = null;
    }

    function walk(node, blockEl, keepsNewlines) {
      if (node.nodeType === 3) {
        if (!node.data) return;
        var parts = node.data.split(keepsNewlines ? LINE_BREAK_RE : BLANK_LINE_RE);
        for (var p = 0; p < parts.length; p++) {
          if (p > 0) flush();
          if (!parts[p]) continue;
          ensure(blockEl);
          cur.text += parts[p];
        }
        return;
      }
      if (node.nodeType !== 1) return;
      var el = node;
      var tag = el.localName;
      if (SKIP_TAGS[tag] || el.id === OVERLAY_HOST_ID) return;
      if (tag === 'br') {
        flush();
        return;
      }
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return;
      if (tag === 'sup' && FOOTNOTE_SUP_RE.test(el.textContent || '')) return;
      var page = pageMarkerOf(el);
      if (page) {
        ensure(blockEl);
        cur.marks.push({ at: cur.text.length, page: page });
        return;
      }
      var paraNo = paraNumberOf(el);
      if (paraNo) {
        ensure(blockEl);
        cur.text += ' ' + paraNo + '. ';
        return;
      }
      var style = window.getComputedStyle(el);
      var display = style.display;
      var keeps = PRESERVED_NEWLINES_RE.test(style.whiteSpace);
      var cell = display === 'table-cell';
      var block = !cell && !INLINE_DISPLAY_RE.test(display);
      // Any display: wikipedia.org sets its h2/h3 inline inside a block wrapper.
      var isHeading = /^h[1-6]$/.test(tag) || el.getAttribute('role') === 'heading';
      if (block) flush();
      if (isHeading) {
        heading = collapse(el.textContent).slice(0, 120) || heading;
        inHeading += 1;
      }
      if (cell && cur) cur.text += ' ';
      var childBlock = block ? el : blockEl;
      for (var c = el.firstChild; c; c = c.nextSibling) walk(c, childBlock, keeps);
      if (el.shadowRoot) {
        for (var s = el.shadowRoot.firstChild; s; s = s.nextSibling) walk(s, childBlock, keeps);
      }
      if (cell && cur) cur.text += ' ';
      if (block) flush();
      if (isHeading) inHeading -= 1;
    }

    if (rootEl) walk(rootEl, rootEl, false);
    flush();
    return lines;
  }

  function findText(query, maxResults) {
    var limit = Math.min(Math.max(Number(maxResults) || DEFAULT_RESULTS, 1), MAX_RESULTS);
    var paras = buildParas(collectLines(document.body));
    var res = matchQuote(paras, query);
    var dom = root.__lexi.domIndex;
    return {
      match: res.match,
      score: res.score,
      total: res.total,
      results: res.hits.slice(0, limit).map(function (hit) {
        var d = describeHit(paras, hit);
        return {
          snippet: d.snippet,
          para: d.para,
          page: d.page,
          heading: d.heading,
          ref: d.el && dom && dom.refFor ? dom.refFor(d.el) : null,
        };
      }),
    };
  }

  root.__lexi.findText = {
    findText: findText,
    normalizeWithMap: normalizeWithMap,
    queryFragments: queryFragments,
    buildParas: buildParas,
    matchQuote: matchQuote,
    describeHit: describeHit,
  };
})();
