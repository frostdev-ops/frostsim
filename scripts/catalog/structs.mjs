// Reads struct field order from upstream headers. Generated .inc rows are positional; deriving order from header turns field insertion into loud mismatch.

import { readFileSync } from 'node:fs';

// Data member: optional const, type, optional pointer stars, name, optional C array bound. Methods filtered out before this runs.
const FIELD = /^\s*(?:const\s+)?[A-Za-z_][\w:]*(?:\s*<[^>]*>)?\s*\**\s*(\w+)\s*(?:\[\s*([A-Z_0-9]+|\d+)\s*\])?\s*;/;

/**
 * @param {string} headerPath
 * @param {string} structName
 * @param {Record<string, number>} [dims] values for symbolic array bounds
 * @returns {{ name: string, count: number }[]}
 */
export function structFields(headerPath, structName, dims = {}) {
  const text = readFileSync(headerPath, 'utf8');
  const start = text.search(new RegExp(`struct\\s+${structName}\\b[^;]`));
  if (start < 0) throw new Error(`struct ${structName} not found in ${headerPath}`);
  let body = text.slice(start, text.indexOf('\n};', start));
  // Nested helper structs (e.g. dbc_item_data_t::stats_t) must not be counted as outer row columns.
  body = body.replace(/\n\s*struct\s+\w+\s*\{[\s\S]*?\n\s*\};/g, '\n');
  const fields = [];
  for (const line of body.split('\n')) {
    if (/\(|\bstatic\b|\btypedef\b|\busing\b|\breturn\b|^\s*(struct|enum|union)\b/.test(line)) continue;
    const m = FIELD.exec(line);
    if (!m) continue;
    let count = 1;
    if (m[2] !== undefined) {
      count = /^\d+$/.test(m[2]) ? Number(m[2]) : dims[m[2]];
      if (count === undefined) throw new Error(`unknown array bound ${m[2]} in ${structName}.${m[1]}`);
    }
    // std::array<T, N> members declare their bound inside the type.
    const arr = /std::array<[^,]+,\s*(\d+)\s*>/.exec(line);
    if (arr) count = Number(arr[1]);
    fields.push({ name: m[1], count });
  }
  if (fields.length === 0) throw new Error(`no fields parsed for ${structName}`);
  return fields;
}

/** Map positional row onto struct's fields; length must match exactly. */
export function mapRow(row, fields, structName) {
  if (row.length !== fields.length) {
    throw new Error(
      `${structName}: row has ${row.length} values, header declares ${fields.length} fields ` +
      `(${fields.map((f) => f.name).join(', ')}) — upstream struct changed, regenerate mapping`
    );
  }
  const out = {};
  fields.forEach((f, i) => {
    let v = row[i];
    if (f.count > 1) {
      // C aggregate initializers elide trailing zeros, so short array is valid.
      if (!Array.isArray(v)) v = v === 0 || v === null ? [] : [v];
      if (v.length > f.count) {
        throw new Error(`${structName}.${f.name}: ${v.length} values exceed the declared ${f.count}`);
      }
      v = v.concat(Array(f.count - v.length).fill(0));
    }
    out[f.name] = v;
  });
  return out;
}

export function mapRows(rows, fields, structName) {
  return rows.map((r) => mapRow(r, fields, structName));
}
