import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRewriteConnection, resolveManualRewriteConnection, applyRewriteMetadata, rewriteDiagnosticMetadata, REWRITE_REQUEST } from '../rewrite/routing.js';
import { safeRewriteError } from '../rewrite/diagnostics-log.js';

const sources = { CUSTOM: 'custom', CLAUDE: 'claude' };
const connections = [
    { id: 'a', name: 'A', endpoint: 'https://a.invalid/v1', model: 'model-a', format: 'openai' },
    { id: 'b', name: 'B', endpoint: 'https://b.invalid/v1', model: 'model-b', format: 'claude' },
];

test('same connection inherits the saved model and does not mutate settings', () => {
    const route = resolveRewriteConnection({ connectionId: '', model: '' }, connections, 'a');
    assert.equal(route.conn.id, 'a');
    assert.equal(route.model, 'model-a');
    route.conn.model = 'changed';
    assert.equal(connections[0].model, 'model-a');
});

test('second connection and model override are frozen', () => {
    const route = resolveRewriteConnection({ connectionId: 'b', model: 'rewrite-model' }, connections, 'a');
    assert.equal(route.conn.id, 'b');
    assert.equal(route.model, 'rewrite-model');
});

test('manual pen follows the second connection and its model', () => {
    const route = resolveManualRewriteConnection(connections, 'a', { connectionId: 'b', model: 'rewrite-model' });
    assert.equal(route.conn.id, 'b');
    assert.equal(route.model, 'rewrite-model');
});

test('manual pen falls back to the current connection when no second connection is selected', () => {
    const route = resolveManualRewriteConnection(connections, 'a', { connectionId: '', model: '' });
    assert.equal(route.conn.id, 'a');
    assert.equal(route.model, 'model-a');
});

test('cross protocol routing clears first request credentials and transport fields', () => {
    const body = { chat_completion_source: 'custom', custom_url: 'https://a.invalid/v1', custom_include_headers: 'Authorization: Bearer secret-a',
        custom_include_body: 'top_k: 1', custom_exclude_body: '- top_p', secret_id: 'secret', model: 'old' };
    applyRewriteMetadata(body, connections[1], 'model-b', sources);
    assert.equal(body.chat_completion_source, 'claude');
    assert.equal(body.model, 'model-b');
    for (const key of ['custom_url', 'custom_include_headers', 'custom_include_body', 'custom_exclude_body', 'secret_id', 'proxy_password']) {
        assert.equal(Object.hasOwn(body, key), false);
    }
    assert.equal(JSON.stringify(body).includes('secret-a'), false);
});

test('missing route fails explicitly instead of using another API', () => {
    assert.throws(() => resolveRewriteConnection({ connectionId: 'deleted' }, connections, 'a'), /重新选择/);
});

test('request diagnostics mark the rewrite window without body metadata', () => {
    assert.deepEqual(rewriteDiagnosticMetadata(null), { phase: 'initial' });
    assert.deepEqual(rewriteDiagnosticMetadata({ rewriteId: 'job', connectionName: 'B' }),
        { phase: 'rewrite', rewriteId: 'job', connectionName: 'B' });
    const body = { model: 'm' };
    applyRewriteMetadata(body, connections[1], 'model-b', sources, null);
    body[REWRITE_REQUEST] = { id: 'job' };
    assert.equal(JSON.stringify(body).includes('job'), false);
});

test('lifecycle errors are bounded and remove common credentials and URL queries', () => {
    const result = safeRewriteError('Bearer secret-token https://a.invalid/v1?key=private ' + 'x'.repeat(600));
    assert.equal(result.includes('secret-token'), false);
    assert.equal(result.includes('key=private'), false);
    assert.ok(result.length <= 500);
});
