import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticsStore, diagnosticsPeriod, millisecondsUntilNextReset, LOGS_KEY } from '../diagnostics-store.js';

function memoryStorage(seed = {}) {
    const data = new Map(Object.entries(seed));
    return {
        getItem(key) { return data.has(key) ? data.get(key) : null; },
        setItem(key, value) { data.set(key, String(value)); },
        removeItem(key) { data.delete(key); },
        value(key) { return data.get(key); },
    };
}

function record(id, startedAt, updatedAt = startedAt, extra = {}) {
    return { id, startedAt, updatedAt, outcome: 'completed', inFlight: false, ...extra };
}

test('06:00 local boundary assigns the expected period', () => {
    assert.equal(diagnosticsPeriod(new Date(2026, 8, 18, 5, 59, 59)), '2026-09-17');
    assert.equal(diagnosticsPeriod(new Date(2026, 8, 18, 6, 0, 0)), '2026-09-18');
    assert.equal(millisecondsUntilNextReset(new Date(2026, 8, 18, 5, 59, 59)), 1000);
    assert.equal(millisecondsUntilNextReset(new Date(2026, 8, 18, 6, 0, 0)), 24 * 60 * 60 * 1000);
});

test('store persists only the latest request and protects it from a late older tab write', () => {
    const storage = memoryStorage();
    const now = () => new Date(2026, 8, 18, 12).getTime();
    const store = createDiagnosticsStore({ getStorage: () => storage, now });
    const older = record('old', '2026-09-18T02:00:00.000Z');
    const newer = record('new', '2026-09-18T03:00:00.000Z');
    assert.equal(store.save([older, newer]), true);
    assert.equal(JSON.parse(storage.value(LOGS_KEY)).record.id, 'new');
    assert.equal(store.save([older]), true);
    assert.equal(JSON.parse(storage.value(LOGS_KEY)).record.id, 'new');
});

test('load migrates v1 to its latest valid record', () => {
    const first = record('first', '2026-09-18T02:00:00.000Z');
    const latest = record('latest', '2026-09-18T03:00:00.000Z', '2026-09-18T03:01:00.000Z');
    const storage = memoryStorage({ [LOGS_KEY]: JSON.stringify({ schemaVersion: 1, records: [first, latest] }) });
    const store = createDiagnosticsStore({ getStorage: () => storage,
        now: () => new Date(2026, 8, 18, 12).getTime() });
    const loaded = store.load();
    assert.deepEqual(loaded.records.map(item => item.id), ['latest']);
    assert.equal(JSON.parse(storage.value(LOGS_KEY)).schemaVersion, 2);
});

test('restart after a missed 06:00 boundary removes the previous period record', () => {
    const storage = memoryStorage();
    let time = new Date(2026, 8, 18, 5, 50).getTime();
    let store = createDiagnosticsStore({ getStorage: () => storage, now: () => time });
    store.save([record('before-reset', new Date(time).toISOString())]);
    time = new Date(2026, 8, 18, 7, 0).getTime();
    store = createDiagnosticsStore({ getStorage: () => storage, now: () => time });
    const loaded = store.load();
    assert.deepEqual(loaded.records, []);
    assert.equal(loaded.pruned, true);
    assert.equal(JSON.parse(storage.value(LOGS_KEY)).record, null);
});

test('an in-flight snapshot restored in the same period is marked incomplete', () => {
    const storage = memoryStorage();
    const now = () => new Date(2026, 8, 18, 12).getTime();
    const store = createDiagnosticsStore({ getStorage: () => storage, now });
    store.save([record('flight', '2026-09-18T03:00:00.000Z', undefined, { outcome: 'pending', inFlight: true })]);
    const loaded = createDiagnosticsStore({ getStorage: () => storage, now }).load();
    assert.equal(loaded.records[0].outcome, 'incomplete_snapshot');
    assert.equal(loaded.records[0].inFlight, false);
});