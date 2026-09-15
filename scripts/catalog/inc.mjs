// Parser for simc generated C++ data tables (vendor/simc/engine/dbc/generated/*.inc): brace-literal arrays from upstream DB2 extractor.

/** @typedef {string|number|null|Ref|Value[]} Value */
/** @typedef {{ ref: string, index: number }} Ref */

const DECL = /(?:^|\n)\s*static\s+(?:const|constexpr)\b[^;{]*?\b(__\w+)\s*(?:\[[^\]]*\]\s*)*(?:=\s*)?\{/g;

/**
 * @param {string} text
 * @returns {Map<string, Value[][]>} declaration name -> rows -> fields
 */
export function parseInc(text) {
  const out = new Map();
  DECL.lastIndex = 0;
  let m;
  while ((m = DECL.exec(text)) !== null) {
    const open = text.indexOf('{', m.index + m[0].length - 1);
    const close = matchBrace(text, open);
    if (close < 0) throw new Error(`unbalanced braces for ${m[1]}`);
    let body = text.slice(open + 1, close);
    if (isSingleWrapped(body)) body = unwrap(body);
    out.set(m[1], splitTop(body).map(toFields));
    DECL.lastIndex = close;
  }
  return out;
}

/** Find closing } matching { at open, skip strings/chars/comments. */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") { i = skipQuoted(text, i); continue; }
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i) + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Find closing quote of literal starting at i. */
function skipQuoted(text, i) {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text[j] === q) return j;
  }
  throw new Error('unterminated string literal');
}

/** Body is one brace group + whitespace/comma (std::array double brace). */
function isSingleWrapped(body) {
  const s = body.trimStart();
  if (!s.startsWith('{')) return false;
  const end = matchBrace(s, 0);
  return end >= 0 && /^[\s,]*$/.test(s.slice(end + 1));
}

function unwrap(body) {
  const s = body.trimStart();
  return s.slice(1, matchBrace(s, 0));
}

/** Split on top-level commas (drop comments, keep braces). */
function splitTop(body) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'") { i = skipQuoted(body, i); continue; }
    if (c === '/' && body[i + 1] === '/') { const nl = body.indexOf('\n', i); i = nl < 0 ? body.length : nl; continue; }
    if (c === '/' && body[i + 1] === '*') { i = body.indexOf('*/', i) + 1; continue; }
    if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts.map(stripComments).filter((p) => p.trim() !== '');
}

function stripComments(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { const e = skipQuoted(s, i); out += s.slice(i, e + 1); i = e; continue; }
    if (c === '/' && s[i + 1] === '/') { const nl = s.indexOf('\n', i); i = nl < 0 ? s.length : nl; out += '\n'; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i) + 1; continue; }
    out += c;
  }
  return out;
}

/** Row: brace group (struct) or bare scalar (plain arrays). */
function toFields(part) {
  const s = part.trim();
  if (!s.startsWith('{')) return [value(s)];
  return splitTop(s.slice(1, matchBrace(s, 0))).map((f) => value(f.trim()));
}

const REF = /^&(__\w+)\s*\[\s*(\d+)\s*\]$/;

/** @returns {Value} */
function value(tok) {
  const s = tok.trim();
  if (s === '' || s === 'nullptr' || s === 'NULL') return null;
  if (s.startsWith('{')) return splitTop(s.slice(1, matchBrace(s, 0))).map((f) => value(f.trim()));
  if (s.startsWith('"')) return unescapeC(s);
  const ref = REF.exec(s);
  if (ref) return { ref: ref[1], index: Number(ref[2]) };
  // Hex first (stripping trailing f would truncate 0xffff...).
  if (/^-?0[xX][0-9a-fA-F]+[uUlL]*$/.test(s)) {
    const big = BigInt(s.replace(/[uUlL]+$/, ''));
    // uint64 (race_mask) exceeds Number.MAX_SAFE_INTEGER; keep as hex.
    return big > BigInt(Number.MAX_SAFE_INTEGER) ? '0x' + big.toString(16) : Number(big);
  }
  const num = s.replace(/[uUlL]+$/, '').replace(/[fF]$/, '');
  if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(num)) return Number(num);
  return s; // bare identifier (e.g. a chunk name in a span table)
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'" };

/** Concatenate adjacent string literals (C preprocessor style). */
function unescapeC(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '"') continue;
    const end = skipQuoted(s, i);
    const raw = s.slice(i + 1, end);
    for (let j = 0; j < raw.length; j++) {
      if (raw[j] === '\\') { out += ESCAPES[raw[++j]] ?? raw[j]; } else out += raw[j];
    }
    i = end;
  }
  return out;
}

/** Row → object with positional field names from upstream struct. */
export function named(rows, fields) {
  return rows.map((r) => {
    const o = {};
    for (let i = 0; i < fields.length; i++) o[fields[i]] = r[i] ?? null;
    return o;
  });
}

/** Tokenize: port of util::tokenize() from simc. */
export function tokenize(name) {
  let s = String(name).replace(/^[_+]+/, '');
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0x80) continue;
    if (/[a-zA-Z]/.test(ch)) out += ch.toLowerCase();
    else if (ch === ' ') out += '_';
    else if (ch === '_' || ch === '+' || ch === '.' || ch === '%' || /[0-9]/.test(ch)) out += ch;
  }
  return out;
}
