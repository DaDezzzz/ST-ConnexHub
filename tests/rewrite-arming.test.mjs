import test from 'node:test';
import assert from 'node:assert/strict';

// Mirrors index.js arm/release semantics: an armed rewrite must be consumed by the
// very next CHAT_COMPLETION_SETTINGS_READY regardless of listener order, and a
// released route must never affect later ordinary requests.
function createRouter() {
    const routes = new Map();
    let armedId = null;
    return {
        begin(route) {
            const id = route.id;
            routes.set(id, route);
            armedId = id;
            return {
                id,
                release() {
                    routes.delete(id);
                    if (armedId === id) armedId = null;
                },
            };
        },
        apply(body) {
            const route = armedId ? routes.get(armedId) : null;
            if (!route) return { applied: false, conn: 'selected' };
            body.model = route.model;
            body.chat_completion_source = route.source;
            return { applied: true, conn: route.conn };
        },
        get armed() { return armedId; },
    };
}

test('armed rewrite is applied even when injection runs before the controller listener', () => {
    const router = createRouter();
    const job = router.begin({ id: 'r1', model: 'rewrite-model', source: 'claude', conn: 'B' });
    const body = { model: 'main-model', chat_completion_source: 'custom' };
    assert.deepEqual(router.apply(body), { applied: true, conn: 'B' });
    assert.equal(body.model, 'rewrite-model');
    job.release();
    assert.equal(router.armed, null);
});

test('released rewrite cannot hijack a later ordinary request', () => {
    const router = createRouter();
    const job = router.begin({ id: 'r2', model: 'm', source: 'claude', conn: 'B' });
    job.release();
    const body = { model: 'main-model', chat_completion_source: 'custom' };
    assert.deepEqual(router.apply(body), { applied: false, conn: 'selected' });
    assert.equal(body.model, 'main-model');
    assert.equal(body.chat_completion_source, 'custom');
});

test('starting a second route replaces the first arm without leaking it', () => {
    const router = createRouter();
    router.begin({ id: 'a', model: 'a', source: 'claude', conn: 'A' });
    router.begin({ id: 'b', model: 'b', source: 'claude', conn: 'B' });
    const body = {};
    assert.equal(router.apply(body).conn, 'B');
    assert.equal(router.armed, 'b');
});
