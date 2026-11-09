// Motor de clasificación inteligente: lectura de contenido (PDF/XLSX/CSV),
// reglas personalizadas, extracción de fechas/referencias y renombrado por plantilla.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CATEGORIES = {
  'Documentos': ['pdf', 'doc', 'docx', 'txt', 'odt', 'rtf', 'md', 'epub'],
  'Hojas de cálculo': ['xls', 'xlsx', 'csv', 'ods'],
  'Presentaciones': ['ppt', 'pptx', 'odp', 'key'],
  'Imágenes': ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'ico', 'tiff'],
  'Video': ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm'],
  'Audio': ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'],
  'Comprimidos': ['zip', 'rar', '7z', 'tar', 'gz'],
  'Instaladores': ['exe', 'msi'],
};
const TEMP_EXT = ['crdownload', 'part', 'partial', 'tmp', 'download', 'opdownload', 'crswap'];

const ext = n => path.extname(n).slice(1).toLowerCase();
const isTemp = n => TEMP_EXT.includes(ext(n)) || n.startsWith('~$') || ['desktop.ini', 'thumbs.db'].includes(n.toLowerCase());
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');

// ---------------- Hash ----------------
function sha256(file) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

// ---------------- Extracción de contenido ----------------
async function extractText(file, { maxPages = 3, maxRows = 20 } = {}) {
  const e = ext(file);
  try {
    if (e === 'pdf') {
      const pdf = require('pdf-parse/lib/pdf-parse.js');
      const r = await pdf(fs.readFileSync(file), { max: maxPages });
      return (r.text || '') + '\n' + Object.values(r.info || {}).join(' ');
    }
    if (['xlsx', 'xlsm', 'xls', 'ods'].includes(e)) {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(file, { sheetRows: maxRows });
      return wb.SheetNames.map(n => n + '\n' + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
    }
    if (['csv', 'txt', 'xml', 'json', 'md'].includes(e)) {
      const buf = fs.readFileSync(file).subarray(0, 20000);
      return buf.toString('utf8').split(/\r?\n/).slice(0, maxRows * 5).join('\n');
    }
  } catch (err) {
    console.warn('No se pudo leer', file, err.message);
  }
  return '';
}

// ---------------- Fechas ----------------
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12 };
const M = Object.keys(MESES).sort((a, b) => b.length - a.length).join('|');
const PATTERNS = [
  ['ymd', /\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/g],
  ['dmy', /\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2})\b/g],
  ['dMy', new RegExp(`\\b(0?[1-9]|[12]\\d|3[01])\\s*(?:de\\s+)?(${M})\\.?\\s*(?:de\\s+|del\\s+)?(20\\d{2})\\b`, 'gi')],
  ['My', new RegExp(`\\b(${M})\\.?\\s*(?:de\\s+|del\\s+|-|/)?\\s*(20\\d{2})\\b`, 'gi')],
];
const CONTEXT = /(fecha\s+(de\s+)?(emisi[oó]n|expedici[oó]n|factura|corte)|periodo(\s+facturado)?|mes\s+de|corte)/gi;

function valid(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || y < 2000 || y > new Date().getFullYear() + 1) return null;
  return dt;
}
function fromMatch(t, g) {
  if (t === 'ymd') return valid(+g[1], +g[2], +g[3]);
  if (t === 'dmy') return valid(+g[3], +g[2], +g[1]);
  if (t === 'dMy') return valid(+g[3], MESES[g[2].toLowerCase()], +g[1]);
  if (t === 'My') return valid(+g[2], MESES[g[1].toLowerCase()], 1);
}
function firstDate(text) {
  for (const [t, rx] of PATTERNS) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(text))) { const d = fromMatch(t, m); if (d) return d; }
  }
  return null;
}
function extractDate(text) {
  if (!text) return null;
  let c;
  CONTEXT.lastIndex = 0;
  while ((c = CONTEXT.exec(text))) {
    const d = firstDate(text.slice(c.index + c[0].length, c.index + c[0].length + 60));
    if (d) return d;
  }
  return firstDate(text);
}

// ---------------- Clasificación ----------------
// rule: { id, searchIn: 'contenido'|'nombre'|'extension', pattern, folder, entity, detail, template, refRegex, priority }
function matches(haystackNorm, pattern) {
  return String(pattern).split(',').map(p => norm(p).trim()).filter(Boolean).find(p =>
    p.length <= 4 && /^[a-z0-9]+$/.test(p) ? new RegExp(`\\b${p}\\b`).test(haystackNorm) : haystackNorm.includes(p));
}

function classify(name, text, rules) {
  const e = ext(name), n = norm(path.parse(name).name), c = norm(text);
  if (c) for (const r of rules) if (r.searchIn === 'contenido') { const k = matches(c, r.pattern); if (k) return { rule: r, folder: r.folder, reason: `Contenido contiene "${k}"` }; }
  for (const r of rules) if (r.searchIn === 'nombre' || r.type === 'contains') { const k = matches(n, r.pattern); if (k) return { rule: r, folder: r.folder, reason: `Nombre contiene "${k}"` }; }
  for (const r of rules) if (r.searchIn === 'extension' || r.type === 'extension') {
    if (String(r.pattern).split(',').map(p => p.trim().toLowerCase().replace(/^\./, '')).includes(e)) return { rule: r, folder: r.folder, reason: `Regla: extensión .${e}` };
  }
  for (const [cat, list] of Object.entries(CATEGORIES)) if (list.includes(e)) return { rule: null, folder: cat, reason: `Tipo: ${cat}` };
  return null;
}

// ---------------- Plantillas ----------------
const clean = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().replace(/\s+/g, '-').replace(/-{2,}/g, '-').slice(0, 60);

function variables(file, text, rule, mtime) {
  const d = extractDate(text) || extractDate(path.parse(file).name) || new Date(mtime);
  const iso = d.toISOString().slice(0, 10);
  let ref = '';
  if (rule?.refRegex) { try { const m = new RegExp(rule.refRegex, 'i').exec(text); if (m) ref = m[1] || m[0]; } catch {} }
  return { fecha: iso, anio: iso.slice(0, 4), mes: iso.slice(5, 7), dia: iso.slice(8, 10),
    entidad: rule?.entity || '', detalle: rule?.detail || '', referencia: ref,
    nombre_original: path.parse(file).name.replace(/\s*\(\d+\)$/, ''), ext: path.extname(file).toLowerCase() };
}
function render(tpl, v, isFolder = false) {
  const out = String(tpl).replace(/\{(\w+)\}/g, (_, k) => (k === 'ext' ? v.ext : clean(v[k])));
  if (isFolder) return out.split(/[\\/]/).map(s => s.trim().replace(/[<>:"|?*]/g, '')).filter(Boolean).join(path.sep);
  const base = out.endsWith(v.ext) ? out.slice(0, -v.ext.length) : out;
  return (base.replace(/_{2,}/g, '_').replace(/^[_-]+|[_-]+$/g, '') || 'archivo') + v.ext;
}

module.exports = { CATEGORIES, ext, isTemp, sha256, extractText, extractDate, classify, variables, render };
