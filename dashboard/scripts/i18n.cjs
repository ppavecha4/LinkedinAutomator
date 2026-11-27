// The app's translation keys: every sentence given to t(), tn(), rich() or msg() in src, plus the
// server's sentences (src/i18n/server-messages.json).
//
//   node scripts/i18n.cjs --check     fails when a language lacks a sentence or breaks a placeholder
//   node scripts/i18n.cjs --keys      prints the keys as JSON
//   node scripts/i18n.cjs --missing es   prints what a language still lacks, as JSON
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const LANGS = ['es', 'pt', 'de', 'nl', 'ar'];
const PLURALS = { es: ['one', 'many', 'other'], pt: ['one', 'many', 'other'], de: ['one', 'other'], nl: ['one', 'other'], ar: ['zero', 'one', 'two', 'few', 'many', 'other'] };

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []);

/** Every string an expression can be: the argument may choose between sentences. */
function literals(node) {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return literals(node.expression);
  if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  return [];
}

function collect() {
  const plain = new Set();
  const plural = new Map(); // other -> one
  for (const file of walk(path.join(root, 'src'))) {
    if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const fn = n.expression.text;
        if (fn === 't' || fn === 'msg' || fn === 'rich') literals(n.arguments[0]).forEach((k) => plain.add(k));
        if (fn === 'tn') {
          const [one] = literals(n.arguments[1]);
          const [other] = literals(n.arguments[2]);
          if (one !== undefined && other !== undefined) plural.set(other, one);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const server = path.join(root, 'src/i18n/server-messages.json');
  if (fs.existsSync(server)) JSON.parse(fs.readFileSync(server, 'utf8')).forEach((k) => plain.add(k));
  // Values translated where shown, e.g. t(role) or t(draft.goal), that no literal call mentions.
  ['owner', 'admin', 'member', 'viewer', 'count'].forEach((k) => plain.add(k));
  return { plain: [...plain].sort(), plural: Object.fromEntries([...plural].sort(([a], [b]) => a.localeCompare(b))) };
}

const marks = (s) => [...s.matchAll(/\{\w+\}|<\/?\w+>/g)].map((m) => m[0]).sort().join(' ');

function problems(lang, keys, dict) {
  const out = [];
  for (const key of keys.plain) {
    const v = dict[key];
    if (typeof v !== 'string' || !v.trim()) out.push(`missing: ${key}`);
    else if (marks(v) !== marks(key)) out.push(`placeholders differ: ${key} -> ${v}`);
  }
  for (const [other, one] of Object.entries(keys.plural)) {
    const v = dict[other];
    if (!v || typeof v !== 'object') { out.push(`missing plural: ${other}`); continue; }
    for (const form of PLURALS[lang]) {
      if (typeof v[form] !== 'string' || !v[form].trim()) { out.push(`missing plural form ${form}: ${other}`); continue; }
      // "one" and Arabic's "zero"/"two" may spell the number out instead of showing it.
      const need = marks(other).split(' ').filter((m) => m && !(m === '{count}' && ['zero', 'one', 'two'].includes(form)));
      const lost = need.filter((m) => !v[form].includes(m));
      const added = (v[form].match(/\{\w+\}/g) || []).filter((m) => !other.includes(m) && !one.includes(m));
      if (lost.length || added.length) out.push(`placeholders differ (${form}): ${other} -> ${v[form]}`);
    }
  }
  const known = new Set([...keys.plain, ...Object.keys(keys.plural)]);
  Object.keys(dict).filter((k) => !known.has(k)).forEach((k) => out.push(`not used any more: ${k}`));
  return out;
}

const load = (lang) => JSON.parse(fs.readFileSync(path.join(root, `src/i18n/locales/${lang}.json`), 'utf8'));
const [mode, arg] = process.argv.slice(2);
const keys = collect();

if (mode === '--keys') {
  console.log(JSON.stringify(keys, null, 1));
} else if (mode === '--missing') {
  const dict = load(arg);
  console.log(JSON.stringify({
    plain: keys.plain.filter((k) => typeof dict[k] !== 'string'),
    plural: Object.fromEntries(Object.entries(keys.plural).filter(([k]) => typeof dict[k] !== 'object')),
  }, null, 1));
} else {
  let failed = 0;
  for (const lang of LANGS) {
    const found = problems(lang, keys, load(lang));
    failed += found.length;
    console.log(`${lang}: ${found.length ? `${found.length} problem(s)` : 'complete'}`);
    found.slice(0, 15).forEach((p) => console.log(`   ${p}`));
  }
  console.log(`${keys.plain.length} sentences and ${Object.keys(keys.plural).length} counted sentences`);
  process.exit(failed ? 1 : 0);
}
