import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticsStore, ENABLED_KEY, LOGS_KEY } from '../diagnostics-store.js';

function fixture() {
    const items = new Map();
    const storage = { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value),
        removeItem: key => items.delete(key) };
    return { items, storage, store: createDiagnosticsStore({ getStorage: () => storage }) };
}
function record(id, extra = {}) {
    return { id, startedAt: new Date().toISOString(), outcome: 'pending', inFlight: true, ...extra };
}

test('storage defaults off, persists summaries and restores unfinished observations without claiming an abort', () => {
    const { store, storage } = fixture();
    assert.deepEqual(store.load(), { enabled: false, records: [] });
    assert.equal(store.setEnabled(true), true);
    const sent = record('a');
    store.save([sent]);
    const restored = createDiagnosticsStore({ getStorage: () => storage }).load();
    assert.equal(restored.enabled, true);
    assert.equal(restored.records[0].outcome, 'incomplete_snapshot');
    assert.equal(restored.records[0].previousOutcome, 'pending');
    assert.equal(sent.outcome, 'pending');
});

test('archives are bounded, old records expire and independent tabs merge by request ID', () => {
    const { store, storage } = fixture();
    const other = createDiagnosticsStore({ getStorage: () => storage });
    store.save([record('a')]);
    other.save([record('b')]);
    assert.equal(store.load().records.length, 2);
    store.save(Array.from({ length: 40 }, (_, i) => record('request-' + i, { inFlight: false })));
    assert.equal(store.load().records.length, 30);
    store.save([record('expired', { startedAt: '2000-01-01T00:00:00.000Z' })]);
    assert.equal(store.load().records.some(r => r.id === 'expired'), false);
    store.clear();
    assert.deepEqual(store.load().records, []);
});

test('a stale tab cannot overwrite a more recent completed record', () => {
    const { store } = fixture();
    const pending = record('a', { updatedAt: '2026-09-07T00:00:01.000Z' });
    const done = { ...pending, updatedAt: '2026-09-07T00:00:02.000Z', outcome: 'completed', inFlight: false };
    store.save([done]); store.save([pending]);
    assert.equal(store.load().records[0].outcome, 'completed');
});

test('storage denial, corrupt data and quota failures never escape into request handling', () => {
    const store = createDiagnosticsStore({ getStorage() { throw new Error('denied'); } });
    assert.deepEqual(store.load(), { enabled: false, records: [] });
    assert.equal(store.save([record('a')]), false);
    assert.equal(store.setEnabled(true), false);
    assert.equal(store.clear(), false);
    assert.equal(store.state, 'unavailable');
    const { items, storage, store: corrupt } = fixture();
    items.set(LOGS_KEY, '{broken');
    assert.deepEqual(corrupt.load().records, []);
    assert.equal(corrupt.save([record('a')]), true);
    storage.setItem = () => { throw new Error('quota'); };
    assert.equal(corrupt.save([record('b')]), false);
});

test('a large archive is size-bounded and does not affect unrelated site storage', () => {
    const { store, items } = fixture();
    items.set('native-settings', 'leave-me');
    store.setEnabled(true);
    store.save(Array.from({ length: 30 }, (_, i) => record('id-' + i, { testPadding: 'x'.repeat(20000) })));
    assert.ok(items.get(LOGS_KEY).length <= 256 * 1024);
    store.clear();
    assert.equal(items.get('native-settings'), 'leave-me');
    assert.equal(items.get(ENABLED_KEY), 'true');
});