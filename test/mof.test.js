import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode, parseCsv, parsePeriod, parseAmount, parseWeekly, toLong, FormatError, sanitize } from '../src/mof.js';

const csv = decode(readFileSync(new URL('./fixtures/week.csv', import.meta.url)));

test('parseCsv handles quotes, commas and embedded newlines', () => {
    assert.deepEqual(parseCsv('a,"1,689 ","x\ny"\r\nb,"say ""hi"""\n'), [['a', '1,689 ', 'x\ny'], ['b', 'say "hi"']]);
});

test('parsePeriod handles full-width digits and year rollover', () => {
    assert.deepEqual(parsePeriod('2005．1．2〜 1．8'), { weekStart: '2005-01-02', weekEnd: '2005-01-08' });
    assert.deepEqual(parsePeriod('2025．12．28〜 1．3'), { weekStart: '2025-12-28', weekEnd: '2026-01-03' });
    assert.equal(parsePeriod('期間'), null);
    assert.equal(parsePeriod('2005．1．2〜 3．8'), null, 'more than 10 days is not a week');
});

test('parseAmount', () => {
    assert.equal(parseAmount('"1,689 "'.replace(/"/g, '')), 1689);
    assert.equal(parseAmount('-2,729'), -2729);
    assert.equal(parseAmount('−5'), -5);
    assert.equal(parseAmount(''), null);
    assert.throws(() => parseAmount('abc'), FormatError);
});

test('parseWeekly reads every week of the real file with consistent totals', () => {
    const { weeks, lastUpdated } = parseWeekly(csv);
    assert.ok(weeks.length > 1000);
    assert.match(lastUpdated, /令和/);
    const first = weeks[0];
    assert.equal(first.weekStart, '2005-01-02');
    assert.equal(first.outward.equityAcquisition, 1689);
    assert.equal(first.outward.equityNet, 270);
    assert.equal(first.inward.totalNet, 10363);
    for (const w of weeks) {
        for (const side of ['outward', 'inward']) {
            const s = w[side];
            if ([s.equityNet, s.longTermDebtNet, s.subtotalNet].every((v) => v !== null)) {
                assert.ok(Math.abs(s.equityNet + s.longTermDebtNet - s.subtotalNet) <= 2, `${w.weekStart} ${side} subtotal`);
            }
            if ([s.subtotalNet, s.shortTermDebtNet, s.totalNet].every((v) => v !== null)) {
                assert.ok(Math.abs(s.subtotalNet + s.shortTermDebtNet - s.totalNet) <= 2, `${w.weekStart} ${side} total`);
            }
        }
    }
    for (let i = 1; i < weeks.length; i++) assert.ok(weeks[i].weekStart > weeks[i - 1].weekStart);
});

test('toLong gives 8 rows per week', () => {
    const { weeks } = parseWeekly(csv);
    const rows = toLong(weeks.at(-1));
    assert.equal(rows.length, 8);
    assert.deepEqual(rows.map((r) => `${r.flow}:${r.asset}`), [
        'outward:equity', 'outward:longTermDebt', 'outward:shortTermDebt', 'outward:total',
        'inward:equity', 'inward:longTermDebt', 'inward:shortTermDebt', 'inward:total',
    ]);
});

test('layout changes fail clearly', () => {
    assert.throws(() => parseWeekly('foo,bar\n1,2'), /Header row/);
    const broken = csv.replace(',取得,処分,ネット,', ',取得,売却,ネット,');
    assert.throws(() => parseWeekly(broken), /Unexpected column layout/);
});

test('sanitize', () => {
    const p = ['C:', 'Users', 'someone', 'x'].join('\\');
    assert.equal(sanitize(`ENOENT ${p}`), 'ENOENT <path>');
});

test('swapped asset blocks, unparseable or missing weeks and truncation are rejected', () => {
    assert.throws(() => parseWeekly(csv.replace('中 長 期 債', '短 期 債')), /Unexpected heading|expected/);
    const weeksOnly = csv.split(/\r?\n/);
    const lastIdx = weeksOnly.map((l) => /^\d{4}．/.test(l)).lastIndexOf(true);
    const badDate = [...weeksOnly]; badDate[lastIdx] = badDate[lastIdx].replace(/^\d{4}．/, '2026／');
    assert.throws(() => parseWeekly(badDate.join('\r\n')), /unrecognised week/);
    const gap = [...weeksOnly]; gap.splice(lastIdx - 1, 1);
    assert.throws(() => parseWeekly(gap.join('\r\n')), /does not follow/);
    assert.throws(() => parseWeekly(weeksOnly.slice(0, lastIdx + 1).join('\r\n')), /truncated/);
});

test('2014 definition change is flagged on each week', () => {
    const { weeks } = parseWeekly(csv);
    assert.equal(weeks[0].equityIncludesInvestmentFunds, false);
    assert.equal(weeks.at(-1).equityIncludesInvestmentFunds, true);
});

test('a data row with an empty date cell is rejected', () => {
    const lines = csv.split(/\r?\n/);
    const lastIdx = lines.map((l) => /^\d{4}．/.test(l)).lastIndexOf(true);
    lines[lastIdx] = lines[lastIdx].replace(/^[^,]*/, '');
    assert.throws(() => parseWeekly(lines.join('\r\n')), /amounts without a readable week/);
});
