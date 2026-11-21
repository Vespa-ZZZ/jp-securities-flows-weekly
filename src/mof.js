// Pure helpers for the Ministry of Finance weekly "International Transactions in Securities" CSV
// (対外及び対内証券売買契約等の状況（週次・指定報告機関ベース）).
// Source: https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/week.csv
// Terms: https://www.mof.go.jp/about_mof/notice/index.html (Public Data License 1.0).

export const CSV_URL = 'https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/week.csv';
export const SOURCE = 'Ministry of Finance, Japan — International Transactions in Securities (weekly, designated major investors)';
export const UNIT = '100 million JPY';

export class FormatError extends Error {}

// Column layout after the period column: 11 resident (assets) + 11 non-resident (liabilities) values.
const GROUP_FIELDS = [
    'equityAcquisition', 'equityDisposition', 'equityNet',
    'longTermDebtAcquisition', 'longTermDebtDisposition', 'longTermDebtNet',
    'subtotalNet',
    'shortTermDebtAcquisition', 'shortTermDebtDisposition', 'shortTermDebtNet',
    'totalNet',
];
export const SERIES = [
    ...GROUP_FIELDS.map((f) => ['outward', f]), // 1. Portfolio Investment Assets (residents' acquisitions of foreign securities)
    ...GROUP_FIELDS.map((f) => ['inward', f]), // 2. Portfolio Investment Liabilities (non-residents' acquisitions of Japanese securities)
];

export function decode(bytes) {
    return new TextDecoder('shift_jis').decode(bytes);
}

/** Minimal RFC 4180 CSV parser (quoted fields, embedded commas/newlines, doubled quotes). */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
            } else field += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

const toHalf = (s) => s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[．.]/g, '.');

/** "2005．12．25〜 1．1" -> { weekStart: "2005-12-25", weekEnd: "2006-01-01" } */
export function parsePeriod(raw) {
    const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})\s*[〜~～]\s*(?:(\d{4})\.)?(\d{1,2})\.(\d{1,2})$/.exec(toHalf(String(raw ?? '').trim()));
    if (!m) return null;
    const [, y, mo, d, y2, mo2, d2] = m.map((x) => (x === undefined ? undefined : Number(x)));
    let endYear = y2 ?? y;
    if (!y2 && (mo2 < mo || (mo2 === mo && d2 < d))) endYear = y + 1;
    const iso = (yy, mm, dd) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    const start = iso(y, mo, d);
    const end = iso(endYear, mo2, d2);
    const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 864e5;
    if (!(days >= 0 && days <= 10)) return null;
    return { weekStart: start, weekEnd: end };
}

/** "1,689 " -> 1689, "-2,729" -> -2729, "" / "-" -> null. Throws on anything else. */
export function parseAmount(raw) {
    const s = toHalf(String(raw ?? '')).replace(/[−－–]/g, '-').replace(/,/g, '').trim();
    if (s === '' || s === '-' || s === '…' || s === '***') return null;
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw new FormatError(`Unexpected amount "${raw}"`);
    return Number(s);
}

/** Parse the whole CSV into weekly records (wide format). */
export function parseWeekly(text) {
    const rows = parseCsv(text);
    const header = rows.findIndex((r) => /^期間/.test((r[0] ?? '').trim()));
    if (header < 0) throw new FormatError('Header row ("期間 / Period") not found');
    const kinds = rows[header + 2] ?? [];
    const expected = ['取得', '処分', 'ネット', '取得', '処分', 'ネット', 'ネット', '取得', '処分', 'ネット', 'ネット'];
    const got = kinds.slice(1, 23).map((s) => s.trim());
    if (got.join('|') !== [...expected, ...expected].join('|')) {
        throw new FormatError(`Unexpected column layout: ${got.join(',')}`);
    }
    // Group headings must sit at the expected columns (a swapped block would otherwise be read as another asset).
    const squash = (s) => String(s ?? '').replace(/[\s　]/g, '');
    const names = rows[header];
    const expectAt = { 1: '株式', 4: '中長期債', 7: '小計', 8: '短期債', 11: '合計', 12: '株式', 15: '中長期債', 18: '小計', 19: '短期債', 22: '合計' };
    for (const [col, label] of Object.entries(expectAt)) {
        if (!squash(names[col]).includes(label)) throw new FormatError(`Unexpected heading at column ${col}: "${names[col]}" (expected ${label})`);
    }
    const sections = rows.slice(0, header).find((r) => squash(r[1]).includes('対外証券投資'));
    if (!sections || !squash(sections[12]).includes('対内証券投資')) throw new FormatError('Outward/inward section headings not found at the expected columns');
    const updated = /最終更新日\s*(.+)/.exec(rows.slice(0, header).flat().find((c) => /最終更新日/.test(c)) ?? '')?.[1]?.trim() ?? null;
    const out = [];
    let lastDataRow = -1;
    for (let i = header + 3; i < rows.length; i++) {
        const r = rows[i];
        const period = parsePeriod(r[0]);
        if (!period) {
            // A row that looks like a week but cannot be parsed is an error, not something to skip.
            if (/^\s*[0-9０-９]{4}/.test(r[0] ?? '')) throw new FormatError(`Row ${i + 1}: unrecognised week "${r[0]}"`);
            // A row with amounts but no readable week (e.g. an empty date cell) is also an error.
            const numericCells = r.slice(1, 23).filter((c) => /^\s*-?[\d,]+(\.\d+)?\s*$/.test(String(c).replace(/[−－]/g, '-'))).length;
            if (numericCells >= 10) throw new FormatError(`Row ${i + 1}: amounts without a readable week ("${r[0]}")`);
            continue;
        }
        lastDataRow = i;
        if (r.length < 23) throw new FormatError(`Row ${i + 1} (${r[0]}) has ${r.length} columns, expected 23`);
        let values;
        try {
            values = r.slice(1, 23).map(parseAmount);
        } catch (err) {
            throw new FormatError(`Row ${i + 1} (${r[0]}): ${err.message}`);
        }
        // From January 2014 investment funds are included in "equity and investment fund shares" (MOF notice 2013-12-27).
        const rec = { ...period, equityIncludesInvestmentFunds: period.weekStart >= '2014-01-01', outward: {}, inward: {} };
        SERIES.forEach(([side, field], k) => { rec[side][field] = values[k]; });
        const prev = out.at(-1);
        if (prev) {
            const expected = new Date(Date.parse(`${prev.weekEnd}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
            if (rec.weekStart !== expected) throw new FormatError(`Week ${rec.weekStart} does not follow ${prev.weekEnd} (missing or out-of-order week)`);
        }
        out.push(rec);
    }
    if (!out.length) throw new FormatError('No weekly rows found');
    // The file ends with notes after the data; their absence means the download was cut off.
    if (!rows.slice(lastDataRow + 1).some((r) => r.some((c) => /Note|注/.test(c)))) {
        throw new FormatError('The CSV seems truncated (notes after the last week are missing)');
    }
    return { weeks: out, lastUpdated: updated };
}

/** Flatten a wide record into one row per side x asset (long format). */
export function toLong(rec) {
    const rows = [];
    for (const side of ['outward', 'inward']) {
        for (const asset of ['equity', 'longTermDebt', 'shortTermDebt']) {
            rows.push({
                weekStart: rec.weekStart, weekEnd: rec.weekEnd, flow: side, asset,
                acquisition: rec[side][`${asset}Acquisition`], disposition: rec[side][`${asset}Disposition`], net: rec[side][`${asset}Net`],
            });
        }
        rows.push({ weekStart: rec.weekStart, weekEnd: rec.weekEnd, flow: side, asset: 'total', acquisition: null, disposition: null, net: rec[side].totalNet });
    }
    return rows;
}

/** Stable fingerprint of a week's published values (for revision detection). */
export function fingerprint(rec) {
    return JSON.stringify([rec.outward, rec.inward]);
}

export function sanitize(message) {
    return String(message)
        .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"`)]*/g, '<path>')
        .replace(/\/(?:home|Users|root|tmp|var|usr)\/[^\s'"`)]*/g, '<path>');
}
