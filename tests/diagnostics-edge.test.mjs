import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics } from '../diagnostics.js';

const url = 'http://localhost/api/backends/chat-completions/generate';
const init = stream => ({ method: 'POST', body: JSON.stringify({ stream,
    chat_completion_source: 'custom', custom_url: 'https://provider.invalid/v1', model: 'offline-fixture',
    messages: [{ role: 'user', content: 'test' }] }) });
function fixture(response) {
    const host = { fetch: async () => response };
    const logger = createDiagnostics({ host, baseUrl: 'http://localhost/', shouldRecord: () => true });
    logger.enable();
    return { host, logger };
}

test('quoted credential fields from upstream errors are masked even if absent from the supplied key list', async () => {
    const message = 'Upstream auth failed: {"api_key":"UNLISTED_KEY", "password":"PASSWORD WITH SPACES", "authorization":"Bearer OTHER_TOKEN"}';
    const { host, logger } = fixture(new Response(JSON.stringify({ error: { message } })));
    await (await host.fetch(url, init(true))).text();
    assert.doesNotMatch(logger.exportJson(), /UNLISTED_KEY|PASSWORD WITH SPACES|OTHER_TOKEN/);
    assert.match(logger.getRecords()[0].error.message, /Upstream auth failed/);
});

test('a DONE following malformed JSON cannot hide that the consumer would fail parsing the same chunk', async () => {
    const data = 'data: INVALID_JSON\n\ndata: [DONE]\n\n';
    const { host, logger } = fixture(new Response(data, { headers: { 'content-type': 'text/event-stream' } }));
    assert.equal(await (await host.fetch(url, init(true))).text(), data);
    assert.equal(logger.getRecords()[0].outcome, 'malformed_sse');
    assert.equal(logger.getRecords()[0].endMarker, 'done');
    assert.doesNotMatch(logger.exportJson(), /INVALID_JSON/);
});

test('unknown successful JSON is not presented as a valid chat response', async () => {
    for (const data of ['true', '{}', '{"unexpected":"PRIVATE_PAYLOAD"}']) {
        const { host, logger } = fixture(new Response(data));
        assert.equal(await (await host.fetch(url, init(false))).text(), data);
        assert.equal(logger.getRecords()[0].outcome, 'unexpected_response');
        assert.doesNotMatch(logger.exportJson(), /PRIVATE_PAYLOAD/);
    }
});

test('null-body HTTP responses are preserved and reported as empty', async () => {
    const raw = new Response(null, { status: 204 });
    const { host, logger } = fixture(raw);
    assert.equal(await host.fetch(url, init(false)), raw);
    assert.equal(logger.getRecords()[0].outcome, 'empty_response');
});