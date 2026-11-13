/**
 * Slice 2.2 — Excel/CSV parsing, mapping suggestions and row cleaning.
 * Pure functions; no database.
 */

import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../src/env';
import {
  countryCode,
  ImportError,
  languageCode,
  normalizeRow,
  parseSpreadsheet,
  suggestMapping,
  type MappingTarget,
} from '../src/lib/leadImport';
import { buildApp } from './app';

const SPANISH_HEADERS = ['Nombre', 'Empresa', 'Cargo', 'Correo', 'Móvil', 'País', 'Idioma', 'Notas'];
const LUCIA = ['Lucía Fernández', 'Grupo Andino SA', 'Directora de Compras', 'Lucia@GrupoAndino.pe',
  '987 654 321', 'Perú', 'Español', 'Nos conocimos en Expoalimentaria'];

describe('parsing', () => {
  it('reads a semicolon CSV with a BOM, skipping blank lines', async () => {
    const csv = '﻿Nombre;Correo\n\nAna;ana@x.pe\n;\nLuis;luis@x.pe\n';
    const s = await parseSpreadsheet(Buffer.from(csv, 'utf8'), 'leads.csv');
    expect(s.headers).toEqual(['Nombre', 'Correo']);
    expect(s.rows).toEqual([['Ana', 'ana@x.pe'], ['Luis', 'luis@x.pe']]);
  });

  it('reads the first non-empty sheet of an .xlsx, with formulas, links and dates as text', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Empty');
    const ws = wb.addWorksheet('Contactos');
    ws.addRow(['Name', 'Email', 'Score', 'Site', 'Met']);
    ws.addRow(['Eve', { text: 'eve@acme.test', hyperlink: 'mailto:eve@acme.test' }, { formula: '1+1', result: 2 },
      'acme.test', new Date('2026-01-15T00:00:00Z')]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const s = await parseSpreadsheet(buf, 'leads.xlsx');
    expect(s.sheetName).toBe('Contactos');
    expect(s.rows[0]).toEqual(['Eve', 'eve@acme.test', '2', 'acme.test', '2026-01-15']);
  });

  it('refuses legacy .xls, empty files and header-only files with a clear message', async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(parseSpreadsheet(ole, 'old.xls')).rejects.toThrow(/\.xls files are not supported/);
    await expect(parseSpreadsheet(Buffer.alloc(0), 'x.csv')).rejects.toThrow(ImportError);
    await expect(parseSpreadsheet(Buffer.from('Name,Email\n'), 'x.csv')).rejects.toThrow(/no data rows/);
  });

  it('enforces the row limit', async () => {
    const csv = 'Name,Email\n' + Array.from({ length: 10_001 }, (_, i) => `N${i},n${i}@x.io`).join('\n');
    await expect(parseSpreadsheet(Buffer.from(csv), 'big.csv')).rejects.toThrow(/limit is 10000/);
  });
});

describe('mapping suggestions', () => {
  it('maps Spanish headers, accents and all', () => {
    const { mapping, basis } = suggestMapping(SPANISH_HEADERS, [LUCIA]);
    expect(mapping).toEqual(['full_name', 'company', 'title', 'email', 'phone', 'country', 'language', 'note']);
    expect(basis.every((b) => b === 'header')).toBe(true);
  });

  it('maps Arabic and Hindi headers', () => {
    expect(suggestMapping(['الاسم', 'البريد الإلكتروني', 'رقم الهاتف', 'الدولة'], [[]]).mapping)
      .toEqual(['full_name', 'email', 'phone', 'country']);
    expect(suggestMapping(['नाम', 'ईमेल', 'मोबाइल', 'भाषा'], [[]]).mapping)
      .toEqual(['full_name', 'email', 'phone', 'language']);
  });

  it('falls back to the values for unknown headers, and uses each field once', () => {
    const rows = [['a@x.io', '+51 987 654 321', 'x'], ['b@y.io', '+971 50 123 4567', 'y']];
    const { mapping, basis } = suggestMapping(['Contact 1', 'Contact 2', 'Mystery'], rows);
    expect(mapping).toEqual(['email', 'phone', 'ignore']);
    expect(basis).toEqual(['values', 'values', 'none']);
    expect(suggestMapping(['Phone', 'Mobile'], [[]]).mapping).toEqual(['phone', 'ignore']);
  });
});

describe('countries and languages', () => {
  it.each([
    ['Perú', 'PE'], ['peru', 'PE'], ['PE', 'PE'], ['PER', 'PE'], ['UAE', 'AE'],
    ['الإمارات العربية المتحدة', 'AE'], ['Emiratos Árabes Unidos', 'AE'], ['भारत', 'IN'], ['Atlantis', null],
  ])('%s → %s', (input, code) => {
    expect(countryCode(input)).toBe(code);
  });

  it.each([
    ['es', 'es'], ['ES_pe', 'es-PE'], ['Español', 'es'], ['árabe', 'ar'], ['العربية', 'ar'],
    ['हिन्दी', 'hi'], ['Klingon', null],
  ])('%s → %s', (input, code) => {
    expect(languageCode(input)).toBe(code);
  });
});

describe('row cleaning', () => {
  const mapping = suggestMapping(SPANISH_HEADERS, [LUCIA]).mapping;

  it('normalises a Peruvian row: E.164 phone from the country, lower-case email, language, note', () => {
    const { lead, problems } = normalizeRow(LUCIA, SPANISH_HEADERS, mapping, null);
    expect(problems).toEqual([]);
    expect(lead).toMatchObject({
      full_name: 'Lucía Fernández',
      company: 'Grupo Andino SA',
      email: 'lucia@grupoandino.pe',
      phone: '+51987654321',
      country: 'PE',
      language: 'es',
      note: 'Notas: Nos conocimos en Expoalimentaria',
    });
  });

  it('uses the import\'s default country when the row has none', () => {
    const row = [...LUCIA];
    row[5] = '';
    expect(normalizeRow(row, SPANISH_HEADERS, mapping, 'PE').lead?.phone).toBe('+51987654321');
    expect(normalizeRow(row, SPANISH_HEADERS, mapping, null).problems).toContain('invalid_phone');
  });

  it('keeps a row with a bad email when the phone works, and says so', () => {
    const row = [...LUCIA];
    row[3] = 'not-an-email';
    const r = normalizeRow(row, SPANISH_HEADERS, mapping, null);
    expect(r.lead?.email).toBeNull();
    expect(r.problems).toEqual(['invalid_email']);
  });

  it('rejects rows with no name or no way to reach them', () => {
    const noName = [...LUCIA];
    noName[0] = '';
    expect(normalizeRow(noName, SPANISH_HEADERS, mapping, null).lead).toBeNull();
    const noContact = [...LUCIA];
    noContact[3] = '';
    noContact[4] = '';
    expect(normalizeRow(noContact, SPANISH_HEADERS, mapping, null).problems).toContain('no_contact_method');
  });

  it('builds the name from first + last, and the company from a work email domain', () => {
    const headers = ['First', 'Last', 'Email'];
    const m: MappingTarget[] = ['first_name', 'last_name', 'email'];
    expect(normalizeRow(['Ana', 'Ruiz', 'ana@ruiz-foods.com'], headers, m, null).lead)
      .toMatchObject({ full_name: 'Ana Ruiz', company: 'ruiz-foods.com' });
    // Free-mail domains are not companies.
    expect(normalizeRow(['Ana', 'Ruiz', 'ana@gmail.com'], headers, m, null).lead?.company).toBe('Ana Ruiz');
  });
});

describe('upload route: limits before the database', () => {
  const original = { ...env };
  afterEach(() => Object.assign(env, original));

  it('rejects files over 10 MB with 413, viewers with 403, and bad file names with 400', async () => {
    env.authMode = 'bypass';
    const app = buildApp();
    const url = '/api/campaigns/00000000-0000-4000-8000-000000000001/imports';
    const big = await request(app).post(`${url}?filename=big.csv`)
      .set('Content-Type', 'application/octet-stream').send(Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    expect(big.status).toBe(413);
    const viewer = await request(app).post(`${url}?filename=x.csv`).set('x-dev-role', 'viewer')
      .set('Content-Type', 'application/octet-stream').send(Buffer.from('a,b\n1,2'));
    expect(viewer.status).toBe(403);
    const exe = await request(app).post(`${url}?filename=virus.exe`)
      .set('Content-Type', 'application/octet-stream').send(Buffer.from('a,b\n1,2'));
    expect(exe.status).toBe(400);
  });
});
