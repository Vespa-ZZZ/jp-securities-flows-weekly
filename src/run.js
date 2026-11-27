import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { pushDataWithinLimit } from './charging.js';
import { CSV_URL, SOURCE, UNIT, decode, fingerprint, parseWeekly, sanitize, toLong } from './mof.js';

const USER_AGENT = 'jp-securities-flows-weekly-actor/1.0';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKS_PER_BATCH = 60; // whole weeks per dataset write (long format: 8 rows per week)
const MAX_WAIT_MS = 120000;

class InputError extends Error {}

function retryAfterMs(res) {
    const h = res.headers.get('retry-after');
    if (!h) return 0;
    if (/^\d+$/.test(h)) return Number(h) * 1000;
    const t = Date.parse(h);
    return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}

async function fetchCsv(fetchImpl, sleep, log) {
    let wait = 0;
    for (let attempt = 0; attempt <= 3; attempt++) {
        if (attempt) await sleep(Math.max(wait, 3000 * 2 ** (attempt - 1)));
        let res;
        let bytes;
        try {
            res = await fetchImpl(CSV_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) });
            if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
        } catch (err) {
            if (attempt === 3) throw new Error(`Network error: ${err.message}`);
            log.warning('Network error, retrying');
            wait = 0;
            continue;
        }
        if (res.ok) return decode(bytes);
        if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} for ${CSV_URL}`);
        if (attempt === 3) throw new Error(`HTTP ${res.status} for ${CSV_URL} after retries`);
        wait = retryAfterMs(res);
        if (wait > MAX_WAIT_MS) throw new Error(`HTTP ${res.status}: the server asked to wait ${Math.round(wait / 1000)} s — try again later`);
        log.warning(`HTTP ${res.status}, retrying`);
    }
    throw new Error('Request failed');
}

// State saves are retried; if they still fail the run fails, and the next run may repeat that batch
// (rows carry a stable eventId for de-duplication).
async function saveWithRetry(fn, sleep, log) {
    for (let attempt = 0; ; attempt++) {
        try { return await fn(); } catch (err) {
            if (attempt === 3) throw new Error(`Could not save monitoring state: ${err.message}`);
            log.warning('Saving monitoring state failed, retrying');
            await sleep(2000 * 2 ** attempt);
        }
    }
}

const validDate = (v) => DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export async function run({ actor, log, fetchImpl = fetch, sleep = delay }) {
    await actor.init();
    try {
        const input = (await actor.getInput()) ?? {};
        const format = input.format ?? 'wide';
        if (!['wide', 'long'].includes(format)) throw new InputError('format must be "wide" or "long".');
        const from = input.from || null;
        const to = input.to || null;
        for (const [k, v] of [['from', from], ['to', to]]) if (v && !validDate(v)) throw new InputError(`${k} must be a valid date YYYY-MM-DD.`);
        if (from && to && from > to) throw new InputError('from must not be later than to.');
        let latestWeeks = null;
        if (!from && !to) {
            latestWeeks = input.latestWeeks ?? 8;
            if (!Number.isInteger(latestWeeks) || latestWeeks < 1 || latestWeeks > 5000) throw new InputError('latestWeeks must be an integer from 1 to 5000.');
        }
        const onlyNew = input.onlyNew ?? false;
        if (typeof onlyNew !== 'boolean') throw new InputError('onlyNew must be true or false.');
        const stateKey = input.stateKey || 'default';
        if (!/^[a-zA-Z0-9_-]{1,50}$/.test(stateKey)) throw new InputError('stateKey may only contain letters, digits, "-" and "_" (max 50).');

        const { weeks, lastUpdated } = parseWeekly(await fetchCsv(fetchImpl, sleep, log));
        let selected = weeks.filter((w) => (!from || w.weekEnd >= from) && (!to || w.weekStart <= to));
        if (latestWeeks) selected = selected.slice(-latestWeeks);

        // Monitoring: week -> fingerprint of the published values. New and revised weeks are output once.
        const store = onlyNew ? await actor.openKeyValueStore('jp-securities-flows-weekly-state') : null;
        const state = onlyNew ? ((await store.getValue(`weeks-${stateKey}`)) ?? {}) : {};
        const todo = [];
        for (const w of selected) {
            const fp = fingerprint(w);
            const saved = state[w.weekStart];
            const previous = typeof saved === 'string' ? saved : saved?.previous;
            if (onlyNew && previous === fp) continue;
            const changeType = onlyNew ? (previous === undefined ? 'new' : 'revision') : null;
            const offset = format === 'long' && saved?.fingerprint === fp ? saved.rows : 0;
            todo.push({ w, fp, previous, changeType, offset });
        }

        // Checkpoint each batch, including progress within a week when a long-format batch is cut short.
        let pushed = 0;
        let chargeLimitReached = false;
        for (let i = 0; i < todo.length; i += WEEKS_PER_BATCH) {
            const batch = todo.slice(i, i + WEEKS_PER_BATCH);
            const rowsByWeek = batch.map(({ w, fp, changeType, offset }) => {
                // eventId is stable per week and published values, so consumers can de-duplicate after a rerun.
                const meta = { unit: UNIT, lastUpdated, sourceUrl: CSV_URL, source: SOURCE, ...(changeType ? { changeType, eventId: `${w.weekStart}:${createHash('sha1').update(fp).digest('hex').slice(0, 12)}` } : {}) };
                if (format === 'wide') return [{ ...w, ...meta }];
                return toLong(w).slice(offset).map((row) => ({ ...row, equityIncludesInvestmentFunds: w.equityIncludesInvestmentFunds, ...meta }));
            });
            const rows = rowsByWeek.flat();
            const result = await pushDataWithinLimit(actor, rows);
            chargeLimitReached = result?.eventChargeLimitReached === true;
            const savedCount = chargeLimitReached ? result.chargedCount : rows.length;
            pushed += savedCount;
            if (onlyNew && savedCount > 0) {
                let remaining = savedCount;
                for (const [index, { w, fp, previous, offset }] of batch.entries()) {
                    if (remaining === 0) break;
                    const size = rowsByWeek[index].length;
                    state[w.weekStart] = remaining >= size ? fp : { fingerprint: fp, previous, rows: offset + remaining };
                    remaining -= Math.min(remaining, size);
                }
                await saveWithRetry(() => store.setValue(`weeks-${stateKey}`, state), sleep, log);
            }
            if (chargeLimitReached) {
                log.warning('Pay-per-event charge limit reached. Stopping dataset output.');
                break;
            }
        }

        await actor.setValue('RUN_SUMMARY', {
            weeksInSource: weeks.length, selected: selected.length, pushed, lastUpdated,
            ...(chargeLimitReached && { stopReason: 'spendingLimit' }),
        });
        log.info(`Done. Pushed ${pushed} rows (source last updated: ${lastUpdated ?? 'unknown'}).`);
        await actor.exit();
    } catch (err) {
        const msg = sanitize(err.message);
        log.error(err instanceof InputError ? `Invalid input: ${msg}` : msg);
        await actor.fail(msg);
    }
}
