import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run } from '../src/run.js';

const bytes = readFileSync(new URL('./fixtures/week.csv', import.meta.url));

async function exec(input, body = bytes, state = new Map(), chargeResult, configureActor) {
    const records = [];
    const lifecycle = [];
    const warnings = [];
    const values = new Map();
    let requests = 0;
    let pushes = 0;
    const actor = {
        async init() {},
        async getInput() { return input; },
        async openKeyValueStore() { return { getValue: async (k) => structuredClone(state.get(k) ?? null), setValue: async (k, v) => { state.set(k, structuredClone(v)); } }; },
        async pushData(rows) {
            pushes++;
            records.push(...(chargeResult?.eventChargeLimitReached ? rows.slice(0, chargeResult.chargedCount) : rows));
            return chargeResult;
        },
        async setValue(k, v) { values.set(k, v); },
        async exit() { lifecycle.push('exit'); },
        async fail(m) { lifecycle.push('fail', m); },
    };
    const log = { info() {}, warning(m) { warnings.push(m); }, error() {} };
    configureActor?.(actor, records);
    await run({ actor, log, fetchImpl: async () => { requests++; return typeof body === 'number' ? new Response('x', { status: body }) : new Response(body); }, sleep: async () => {} });
    return { records, lifecycle, requests, warnings, pushes, summary: values.get('RUN_SUMMARY') };
}

test('default: latest 8 weeks in wide format with unit and source', async () => {
    const r = await exec({});
    assert.deepEqual(r.lifecycle, ['exit']);
    assert.equal(r.records.length, 8);
    assert.equal(r.records[0].unit, '100 million JPY');
    assert.ok(r.records[0].outward && r.records[0].inward);
    assert.equal(r.requests, 1);
});

test('date range and long format', async () => {
    const r = await exec({ from: '2005-01-01', to: '2005-01-31', format: 'long' });
    assert.equal(r.records.length, 5 * 8);
    assert.equal(r.records[0].weekStart, '2005-01-02');
});

test('monitoring: new weeks once, then revisions only', async () => {
    const state = new Map();
    const first = await exec({ onlyNew: true, latestWeeks: 3 }, bytes, state);
    assert.deepEqual(first.records.map((x) => x.changeType), ['new', 'new', 'new']);
    const second = await exec({ onlyNew: true, latestWeeks: 3 }, bytes, state);
    assert.equal(second.records.length, 0);
    // Digits and commas are ASCII in CP932, so the last week's final value can be edited in the raw bytes.
    const text = new TextDecoder('shift_jis').decode(bytes);
    const lastLine = text.split(/\r?\n/).filter((l) => /^\d{4}．/.test(l)).at(-1);
    const lastValue = lastLine.slice(lastLine.lastIndexOf(',') + 1); // e.g. "-2,446 " (with quotes)
    const buf = Buffer.from(bytes);
    const at = buf.lastIndexOf(Buffer.from(lastValue, 'latin1'));
    assert.ok(at > 0);
    const edited = Buffer.from(lastValue.replace(/\d/, (d) => String((Number(d) + 1) % 10)), 'latin1');
    edited.copy(buf, at);
    const third = await exec({ onlyNew: true, latestWeeks: 3 }, buf, state);
    assert.deepEqual(third.records.map((x) => x.changeType), ['revision']);
});

test('invalid input and HTTP errors fail clearly', async () => {
    assert.match((await exec({ from: '2025/01/01' })).lifecycle[1], /YYYY-MM-DD/);
    assert.match((await exec({ format: 'csv' })).lifecycle[1], /format/);
    assert.match((await exec({}, 404)).lifecycle[1], /HTTP 404/);
});

test('a failed batch does not re-output already written weeks', async () => {
    const state = new Map();
    let calls = 0;
    const records = [];
    const lifecycle = [];
    const actor = {
        init: async () => {}, getInput: async () => ({ onlyNew: true, latestWeeks: 65, format: 'long' }),
        openKeyValueStore: async () => ({ getValue: async (k) => structuredClone(state.get(k) ?? null), setValue: async (k, v) => { state.set(k, structuredClone(v)); } }),
        pushData: async (r) => { if (++calls === 2) throw new Error('write failed'); records.push(...r); },
        setValue: async () => {}, exit: async () => lifecycle.push('exit'), fail: async () => lifecycle.push('fail'),
    };
    const { run: runActor } = await import('../src/run.js');
    await runActor({ actor, log: { info() {}, warning() {}, error() {} }, fetchImpl: async () => new Response(bytes), sleep: async () => {} });
    assert.equal(lifecycle[0], 'fail');
    assert.equal(Object.keys(state.get('weeks-default')).length, 60);
    const again = await exec({ onlyNew: true, latestWeeks: 65, format: 'long' }, bytes, state);
    assert.equal(again.records.length, 5 * 8);
});

test('a charge-limited long-format write resumes at the first unsaved row of a split week', async () => {
    const input = { onlyNew: true, latestWeeks: 65, format: 'long' };
    const state = new Map();
    const first = await exec(input, bytes, state, { eventChargeLimitReached: true, chargedCount: 11 });
    assert.deepEqual(first.lifecycle, ['exit']);
    assert.equal(first.pushes, 1);
    assert.equal(first.summary.pushed, 11);
    assert.match(first.warnings[0], /charge limit reached/i);
    const progress = state.get('weeks-default');
    assert.equal(typeof progress[first.records[0].weekStart], 'string');
    assert.equal(progress[first.records.at(-1).weekStart].rows, 3);

    const second = await exec(input, bytes, state, { eventChargeLimitReached: true, chargedCount: 2 });
    assert.equal(second.summary.pushed, 2);
    const next = await exec(input, bytes, state, { eventChargeLimitReached: false, chargedCount: 0 });
    assert.equal(next.summary.pushed, 65 * 8 - 13);
    const full = await exec(input);
    assert.deepEqual([...first.records, ...second.records, ...next.records], full.records);
    assert.equal((await exec(input, bytes, state)).summary.pushed, 0);
});

test('Retry-After is honoured and invalid numbers rejected', async () => {
    const waits = [];
    let n = 0;
    const lifecycle = [];
    const { run: runActor } = await import('../src/run.js');
    await runActor({
        actor: { init: async () => {}, getInput: async () => ({ latestWeeks: 1 }), pushData: async () => {}, setValue: async () => {}, exit: async () => lifecycle.push('exit'), fail: async (m) => lifecycle.push('fail', m) },
        log: { info() {}, warning() {}, error() {} },
        fetchImpl: async () => (n++ === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '20' } }) : new Response(bytes)),
        sleep: async (ms) => { waits.push(ms); },
    });
    assert.deepEqual(lifecycle, ['exit']);
    assert.ok(waits[0] >= 20000);
    assert.match((await exec({ latestWeeks: 'invalid' })).lifecycle[1], /latestWeeks/);
    assert.match((await exec({ from: '2025-02-30' })).lifecycle[1], /valid date/);
});

test('state save failures are retried; rows carry a stable eventId', async () => {
    const state = new Map();
    let failures = 1;
    const records = [];
    const lifecycle = [];
    const { run: runActor } = await import('../src/run.js');
    await runActor({
        actor: {
            init: async () => {}, getInput: async () => ({ onlyNew: true, latestWeeks: 2 }),
            openKeyValueStore: async () => ({ getValue: async () => null, setValue: async (k, v) => { if (failures-- > 0) throw new Error('kv down'); state.set(k, v); } }),
            pushData: async (r) => records.push(...r), setValue: async () => {}, exit: async () => lifecycle.push('exit'), fail: async (m) => lifecycle.push('fail', m),
        },
        log: { info() {}, warning() {}, error() {} }, fetchImpl: async () => new Response(bytes), sleep: async () => {},
    });
    assert.deepEqual(lifecycle, ['exit']);
    assert.equal(Object.keys(state.get('weeks-default')).length, 2);
    assert.ok(records.every((r) => /^\d{4}-\d{2}-\d{2}:[0-9a-f]{12}$/.test(r.eventId)));
    assert.match((await exec({ onlyNew: 'false' })).lifecycle[1], /onlyNew/);
});

test('prechecks the dataset item budget and allows non-PPE output', async () => {
    for (const [isPayPerEvent, budget] of [[true, 1], [true, 0], [false, 0]]) {
        const configureActor = (actor, records) => {
            actor.getChargingManager = () => ({
                getPricingInfo: () => ({ isPayPerEvent }),
                calculateMaxEventChargeCountWithinLimit(event) {
                    assert.equal(event, 'apify-default-dataset-item');
                    return budget - records.length;
                },
            });
        };
        const input = { onlyNew: true, latestWeeks: 1, format: 'long' };
        const state = new Map();
        const result = await exec(input, bytes, state, undefined, configureActor);
        assert.deepEqual(result.lifecycle, ['exit']);
        assert.equal(result.records.length, isPayPerEvent ? budget : 8);
        assert.equal(result.summary.pushed, result.records.length);
        assert.equal(result.summary.stopReason, isPayPerEvent ? 'spendingLimit' : undefined);
        const next = await exec(input, bytes, state);
        assert.equal(next.records.length, 8 - result.records.length);
    }
});
