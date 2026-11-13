// Shared number/size formatting. One byte formatter for the whole panel -
// three pages had drifted copies, all with a floor that rendered 0 bytes as
// "1 KB" ("Total: 1 KB in 0 archives"). Mirrors the server-side `bytes`
// Handlebars helper (src/web/app.js) so a size never renders differently in a
// toast than in its table cell.

export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (n === 0) return '0 B';
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log2(Math.abs(n)) / 10), units.length - 1);
  const value = n / 2 ** (10 * i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

// One HTML-escaper for the whole panel - a dozen-plus pages had drifted
// copies, some missing the `?? ''` coercion (throws on null/undefined).
export function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Auto-escaping HTML templates. Every interpolated value is escaped unless it
// is itself the result of html`` or raw(), so call sites cannot forget to:
//
//   el.innerHTML = html`<li title="${name}">${name} ${raw(iconSvg)}</li>`;
//   list.innerHTML = html`<ul>${items.map((i) => html`<li>${i.label}</li>`)}</ul>`;
//
// Arrays are joined (each item escaped the same way); null/undefined render as
// ''. Assigning the result to innerHTML stringifies it. Use raw() only for
// markup the panel itself produced (icons, numbers already formatted), never
// for text that came from a server, a player or a file.
class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export function raw(markup) {
  return new SafeHtml(String(markup ?? ''));
}

function htmlPiece(v) {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(htmlPiece).join('');
  return escapeHtml(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += htmlPiece(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}
