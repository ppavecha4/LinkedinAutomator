/**
 * Excel / CSV lead import: parsing, column-mapping suggestions and row
 * normalisation (SaaS phase 2, slice 2.2). Pure functions; the route
 * (routes/imports.ts) does the database work.
 *
 * Mapping is by column POSITION (`mapping[i]` is the field for column i),
 * so sheets with repeated headers ("Phone", "Phone") still work.
 */

import { createHash } from 'crypto';

import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import countries from 'i18n-iso-countries';
import ar from 'i18n-iso-countries/langs/ar.json' with { type: 'json' };
import de from 'i18n-iso-countries/langs/de.json' with { type: 'json' };
import en from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import es from 'i18n-iso-countries/langs/es.json' with { type: 'json' };
import fr from 'i18n-iso-countries/langs/fr.json' with { type: 'json' };
import hi from 'i18n-iso-countries/langs/hi.json' with { type: 'json' };
import it from 'i18n-iso-countries/langs/it.json' with { type: 'json' };
import pt from 'i18n-iso-countries/langs/pt.json' with { type: 'json' };
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

// ─── Limits ──────────────────────────────────────────────────────────────

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 10_000;
export const MAX_COLUMNS = 100;
const MAX_CELL_CHARS = 2_000;
const MAX_NOTE_CHARS = 1_000;

export class ImportError extends Error {}

// ─── Fields ──────────────────────────────────────────────────────────────

export const FIELDS = [
  'full_name', 'first_name', 'last_name', 'company', 'title', 'email', 'phone',
  'country', 'language', 'linkedin_url', 'company_domain', 'industry',
] as const;
export type Field = (typeof FIELDS)[number];
/** `note`: kept as a personalisation note. `ignore`: dropped. */
export type MappingTarget = Field | 'note' | 'ignore';
export const MAPPING_TARGETS: readonly MappingTarget[] = [...FIELDS, 'note', 'ignore'];

// ─── Parsing ─────────────────────────────────────────────────────────────

export interface ParsedSheet {
  sheetName: string | null;
  headers: string[];
  rows: string[][]; // data rows, each padded/truncated to headers.length
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const clip = (s: string) => (s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) : s);

/** First non-empty row is the header; blank rows are skipped. */
function shape(table: string[][], sheetName: string | null): ParsedSheet {
  const nonEmpty = table
    .map((r) => r.map((c) => clip(String(c ?? '').trim())))
    .filter((r) => r.some((c) => c !== ''));
  if (nonEmpty.length === 0) throw new ImportError('the file has no rows');
  const rawHeaders = nonEmpty[0];
  // Drop trailing empty header cells.
  let width = rawHeaders.length;
  while (width > 0 && rawHeaders[width - 1] === '') width -= 1;
  if (width === 0) throw new ImportError('the first row must contain column names');
  if (width > MAX_COLUMNS) throw new ImportError(`too many columns (max ${MAX_COLUMNS})`);
  const headers = rawHeaders.slice(0, width).map((h, i) => h || `Column ${i + 1}`);
  const rows = nonEmpty.slice(1).map((r) => {
    const out = r.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
  if (rows.length === 0) throw new ImportError('the file has column names but no data rows');
  if (rows.length > MAX_ROWS) {
    throw new ImportError(`too many rows (${rows.length}); the limit is ${MAX_ROWS} per file`);
  }
  return { sheetName, headers, rows };
}

function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}
function isOle(buf: Buffer): boolean {
  // Legacy .xls (OLE2 compound file)
  return buf.length > 8 && buf.readUInt32BE(0) === 0xd0cf11e0;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('text' in v && typeof v.text === 'string') return v.text; // hyperlink
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue); // formula
    if ('error' in v) return '';
    return '';
  }
  return String(v);
}

async function parseXlsx(buf: Buffer): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new ImportError('could not read this Excel file; save it as .xlsx or .csv and try again');
  }
  // The first worksheet that has any data.
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
  if (!ws) throw new ImportError('the workbook is empty');
  if (ws.actualRowCount > MAX_ROWS + 1) {
    throw new ImportError(`too many rows; the limit is ${MAX_ROWS} per file`);
  }
  const table: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as ExcelJS.CellValue[]; // 1-based
    const out: string[] = [];
    for (let i = 1; i < values.length; i += 1) out.push(cellText(values[i]));
    table.push(out);
  });
  return shape(table, ws.name);
}

function parseCsvBuffer(buf: Buffer): ParsedSheet {
  const text = buf.toString('utf8');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  // Pick the delimiter that splits the header line the most.
  const delimiter = [',', ';', '\t', '|'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  let table: string[][];
  try {
    table = parseCsv(text, {
      bom: true,
      delimiter,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
    }) as string[][];
  } catch (e) {
    throw new ImportError(`could not read this CSV file: ${(e as Error).message}`);
  }
  return shape(table, null);
}

export async function parseSpreadsheet(buf: Buffer, fileName: string): Promise<ParsedSheet> {
  if (buf.length === 0) throw new ImportError('the file is empty');
  if (buf.length > MAX_FILE_BYTES) throw new ImportError('the file is larger than 10 MB');
  if (isOle(buf)) throw new ImportError('old .xls files are not supported; save as .xlsx or .csv');
  if (isZip(buf)) return parseXlsx(buf);
  if (/\.xlsx?$/i.test(fileName)) throw new ImportError('this does not look like an Excel file');
  return parseCsvBuffer(buf);
}

// ─── Mapping suggestions ─────────────────────────────────────────────────

/** Lower-case, strip accents/marks, keep letters and digits of any script. */
export function normKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// Header names in the languages we sell into. Keys go through normKey().
const SYNONYMS: Record<Field | 'note', string[]> = {
  full_name: ['name', 'fullname', 'contactname', 'contact', 'nombre', 'nombrecompleto', 'nom', 'nomcomplet',
    'nome', 'nomecompleto', 'naam', 'الاسم', 'الاسمالكامل', 'नाम', 'पूरानाम', 'имя'],
  first_name: ['firstname', 'first', 'givenname', 'forename', 'nombrepila', 'primernombre', 'prenom',
    'primeironome', 'vorname', 'الاسمالاول', 'पहलानाम'],
  last_name: ['lastname', 'last', 'surname', 'familyname', 'apellido', 'apellidos', 'nomdefamille',
    'sobrenome', 'nachname', 'cognome', 'اسمالعائلة', 'उपनाम'],
  company: ['company', 'companyname', 'organization', 'organisation', 'account', 'business', 'empresa',
    'compania', 'societe', 'entreprise', 'firma', 'unternehmen', 'azienda', 'الشركة', 'شركة', 'कंपनी'],
  title: ['title', 'jobtitle', 'position', 'role', 'designation', 'cargo', 'puesto', 'poste', 'fonction',
    'titulo', 'funcao', 'berufsbezeichnung', 'ruolo', 'المسمىالوظيفي', 'الوظيفة', 'पद'],
  email: ['email', 'emailaddress', 'mail', 'email1', 'workemail', 'correo', 'correoelectronico',
    'courriel', 'adresseemail', 'eposta', 'البريدالالكتروني', 'البريد', 'ईमेल'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilephone', 'mobilenumber', 'cell', 'cellphone', 'whatsapp',
    'whatsappnumber', 'telefono', 'movil', 'celular', 'telephone', 'portable', 'telefone', 'handy',
    'cellulare', 'هاتف', 'الهاتف', 'جوال', 'رقمالهاتف', 'फोन', 'मोबाइल'],
  country: ['country', 'pais', 'pays', 'land', 'paese', 'الدولة', 'البلد', 'देश'],
  language: ['language', 'lang', 'idioma', 'langue', 'lingua', 'sprache', 'اللغة', 'भाषा'],
  linkedin_url: ['linkedin', 'linkedinurl', 'linkedinprofile', 'perfillinkedin', 'profillinkedin'],
  company_domain: ['domain', 'website', 'web', 'url', 'companywebsite', 'sitioweb', 'siteweb', 'siteinternet'],
  industry: ['industry', 'sector', 'industria', 'secteur', 'branche', 'settore', 'القطاع', 'उद्योग'],
  note: ['note', 'notes', 'comment', 'comments', 'remarks', 'notas', 'nota', 'observaciones', 'comentarios',
    'commentaires', 'remarques', 'notizen', 'ملاحظات', 'टिप्पणी'],
};

const HEADER_INDEX = new Map<string, Field | 'note'>();
for (const [field, names] of Object.entries(SYNONYMS) as Array<[Field | 'note', string[]]>) {
  for (const n of names) HEADER_INDEX.set(normKey(n), field);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Guess a field from sample values when the header is unknown. */
function guessFromValues(values: string[]): Field | null {
  const vs = values.filter(Boolean).slice(0, 20);
  if (vs.length === 0) return null;
  const share = (pred: (v: string) => boolean) => vs.filter(pred).length / vs.length;
  if (share((v) => EMAIL_RE.test(v)) >= 0.8) return 'email';
  if (share((v) => /linkedin\.com\//i.test(v)) >= 0.8) return 'linkedin_url';
  if (share((v) => /^[+(\d][\d\s().-]{6,}$/.test(v)) >= 0.8) return 'phone';
  return null;
}

export interface MappingSuggestion {
  mapping: MappingTarget[];
  /** Why each column was mapped: header name, sample values, or none. */
  basis: Array<'header' | 'values' | 'none'>;
}

/** Suggest a target per column. Each field is used once; notes may repeat. */
export function suggestMapping(headers: string[], rows: string[][]): MappingSuggestion {
  const taken = new Set<string>();
  const mapping: MappingTarget[] = [];
  const basis: MappingSuggestion['basis'] = [];
  headers.forEach((h, i) => {
    let target: MappingTarget | null = HEADER_INDEX.get(normKey(h)) ?? null;
    let why: MappingSuggestion['basis'][number] = target ? 'header' : 'none';
    if (!target) {
      target = guessFromValues(rows.map((r) => r[i] ?? ''));
      if (target) why = 'values';
    }
    if (target && target !== 'note' && taken.has(target)) target = null;
    if (target && target !== 'note') taken.add(target);
    mapping.push(target ?? 'ignore');
    basis.push(target ? why : 'none');
  });
  return { mapping, basis };
}

// ─── Countries + languages ───────────────────────────────────────────────

const COUNTRY_LOCALES = { en, es, fr, pt, de, it, ar, hi } as const;
for (const l of Object.values(COUNTRY_LOCALES)) countries.registerLocale(l);

const COUNTRY_INDEX = new Map<string, string>();
for (const lang of Object.keys(COUNTRY_LOCALES)) {
  const names = countries.getNames(lang, { select: 'all' }) as Record<string, string[]>;
  for (const [code, list] of Object.entries(names)) {
    for (const n of list) {
      const k = normKey(n);
      if (k && !COUNTRY_INDEX.has(k)) COUNTRY_INDEX.set(k, code);
    }
  }
}
for (const [k, code] of Object.entries({ usa: 'US', uk: 'GB', uae: 'AE', eau: 'AE', ksa: 'SA' })) {
  COUNTRY_INDEX.set(k, code);
}

/** "Perú" / "peru" / "PE" / "PER" / "الإمارات" → ISO-3166 alpha-2, else null. */
export function countryCode(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (/^[A-Za-z]{2}$/.test(v) && countries.isValid(v.toUpperCase())) return v.toUpperCase();
  if (/^[A-Za-z]{3}$/.test(v)) {
    const a2 = countries.alpha3ToAlpha2(v.toUpperCase());
    if (a2) return a2;
  }
  return COUNTRY_INDEX.get(normKey(v)) ?? null;
}

export function countryName(code: string): string {
  return countries.getName(code, 'en') ?? code;
}

const LANGUAGE_NAMES: Record<string, string> = {};
for (const [code, names] of Object.entries({
  en: ['english', 'ingles', 'anglais', 'englisch', 'inglese', 'الانجليزية', 'अंग्रेज़ी', 'अंग्रेजी'],
  es: ['spanish', 'espanol', 'castellano', 'espagnol', 'spanisch', 'spagnolo', 'الاسبانية', 'स्पेनिश'],
  ar: ['arabic', 'arabe', 'arabisch', 'arabo', 'العربية', 'عربي', 'अरबी'],
  hi: ['hindi', 'हिन्दी', 'हिंदी'],
  fr: ['french', 'frances', 'francais', 'franzosisch', 'francese', 'الفرنسية', 'फ्रेंच'],
  pt: ['portuguese', 'portugues', 'portugais', 'portugiesisch', 'portoghese'],
  de: ['german', 'aleman', 'allemand', 'deutsch', 'tedesco'],
  it: ['italian', 'italiano', 'italien', 'italienisch'],
  zh: ['chinese', 'chino', 'chinois', '中文', '汉语'],
  ja: ['japanese', 'japones', 'japonais', '日本語'],
})) {
  for (const n of names) LANGUAGE_NAMES[normKey(n)] = code;
}

/** "es" / "es_pe" / "ES-PE" / "Español" → BCP 47 ("es", "es-PE"), else null. */
export function languageCode(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const m = /^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{2}|\d{3}))?$/.exec(v);
  if (m) return m[2] ? `${m[1].toLowerCase()}-${m[2].toUpperCase()}` : m[1].toLowerCase();
  return LANGUAGE_NAMES[normKey(v)] ?? null;
}

// ─── Row normalisation ───────────────────────────────────────────────────

export interface NormalizedLead {
  full_name: string;
  company: string;
  title: string | null;
  email: string | null;
  phone: string | null;          // E.164
  country: string | null;        // ISO-3166 alpha-2
  language: string | null;       // BCP 47
  linkedin_url: string | null;
  company_domain: string | null;
  industry: string | null;
  note: string | null;
}

export type Problem =
  | 'missing_name' | 'no_contact_method' | 'invalid_email' | 'invalid_phone'
  | 'unknown_country' | 'unknown_language' | 'duplicate_in_file'
  | 'already_a_contact' | 'opted_out'
  // Slice 3.2 — the org's business profile: never-contact list, blocked countries.
  | 'never_contact' | 'blocked_country';

/** Problems that make a row unusable (the rest are warnings). */
export const BLOCKING: ReadonlySet<Problem> = new Set(['missing_name', 'no_contact_method']);

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'yandex.com', 'mail.com', 'gmx.com']);

export function normalizeRow(
  row: string[],
  headers: string[],
  mapping: readonly MappingTarget[],
  defaultCountry: string | null,
): { lead: NormalizedLead | null; problems: Problem[] } {
  const problems: Problem[] = [];
  const get = (f: Field) => {
    const i = mapping.indexOf(f);
    return i >= 0 ? (row[i] ?? '').trim() : '';
  };

  const first = get('first_name');
  const last = get('last_name');
  const fullName = (get('full_name') || [first, last].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
  if (!fullName) problems.push('missing_name');

  let email: string | null = get('email').toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) {
    problems.push('invalid_email');
    email = null;
  }

  const countryRaw = get('country');
  let country = countryRaw ? countryCode(countryRaw) : null;
  if (countryRaw && !country) problems.push('unknown_country');
  country = country ?? defaultCountry;

  const phoneRaw = get('phone').replace(/^whatsapp:/i, '').trim();
  let phone: string | null = null;
  if (phoneRaw) {
    const parsed = parsePhoneNumberFromString(phoneRaw, (country ?? undefined) as CountryCode | undefined);
    if (parsed?.isValid()) phone = parsed.number;
    else problems.push('invalid_phone');
  }

  if (!email && !phone) problems.push('no_contact_method');

  const langRaw = get('language');
  const language = langRaw ? languageCode(langRaw) : null;
  if (langRaw && !language) problems.push('unknown_language');

  const linkedinRaw = get('linkedin_url');
  const linkedin = /linkedin\.com\//i.test(linkedinRaw) ? linkedinRaw : null;

  const domainRaw = get('company_domain').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0] || null;
  const emailDomain = email ? email.split('@')[1] : null;
  const company =
    get('company') ||
    domainRaw ||
    (emailDomain && !FREE_MAIL.has(emailDomain) ? emailDomain : '') ||
    fullName;

  const notes = mapping
    .map((t, i) => (t === 'note' && (row[i] ?? '').trim() ? `${headers[i]}: ${(row[i] ?? '').trim()}` : null))
    .filter(Boolean)
    .join('; ');

  if (problems.some((p) => BLOCKING.has(p))) return { lead: null, problems };
  return {
    lead: {
      full_name: fullName.slice(0, 255),
      company: company.slice(0, 255),
      title: get('title').slice(0, 255) || null,
      email,
      phone,
      country,
      language,
      linkedin_url: linkedin,
      company_domain: domainRaw ?? (emailDomain && !FREE_MAIL.has(emailDomain) ? emailDomain : null),
      industry: get('industry').slice(0, 100) || null,
      note: notes ? notes.slice(0, MAX_NOTE_CHARS) : null,
    },
    problems,
  };
}

/** Keys that identify the same person (for de-duplication). */
export function identityKeys(lead: Pick<NormalizedLead, 'email' | 'phone'>): string[] {
  const keys: string[] = [];
  if (lead.email) keys.push(`e:${lead.email}`);
  if (lead.phone) keys.push(`p:${lead.phone}`);
  return keys;
}
