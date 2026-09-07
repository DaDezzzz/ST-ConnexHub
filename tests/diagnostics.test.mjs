import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics } from '../diagnostics.js';

const encoder = new TextEncoder();
const requestUrl = 'http://localhost/api/backends/chat-completions/generate';
const baseBody = {
    chat_completion_source: 'custom', custom_url: 'https://provider.example/v1',
    model: 'claude-opus-4-5', stream: true, max_tokens: 3000,
    messages: [{ role: 'user', content: 'PRIVATE_PROMPT_DO_NOT_LOG' }],
};
const init = (body = baseBody, extra = {}) => ({ method: 'POST', body: JSON.stringify(body), ...extra });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(fetchImpl, options = {}) {
    const host = { fetch: fetchImpl };
    const logger = createDiagnostics({
        host, baseUrl: 'http://localhost/', shouldRecord: body => body.chat_completion_source === 'custom',
        ...options,
    });
    logger.enable();
    return { host, logger };
}
function sse(text, options = {}) {
    return new Response(text, { headers: { 'content-type': 'text/event-stream' }, ...options });
}
function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

// These tests use the same fetch/Response/ReadableStream seam as the installed extension.
test('disabled diagnostics preserve original fetch promise, arguments and response', async () => {
    const response = sse('data: [DONE]\n\n');
    const promise = Promise.resolve(response);
    let called;
    const original = function (...args) { called = { args, receiver: this }; return promise; };
    const host = { fetch: original };
    const logger = createDiagnostics({ host, baseUrl: 'http://localhost/', shouldRecord: () => true });
    const options = init();
    assert.equal(host.fetch(requestUrl, options), promise);
    logger.enable();
    logger.disable();
    assert.equal(host.fetch, original);
    assert.equal(host.fetch(requestUrl, options), promise);
    assert.equal(called.args[1], options);
    assert.equal(called.receiver, host);
    assert.equal(await promise, response);
    assert.deepEqual(logger.getRecords(), []);
});

test('normal SSE passes exact bytes and request options; only summaries are retained', async () => {
    const text = 'data: {"choices":[{"delta":{"content":"PRIVATE_REPLY"}}]}\r\n\r\n'
        + 'data: {"choices":[{"finish_reason":"stop"}],"usage":{"completion_tokens":12}}\r\n\r\n'
        + 'data: [DONE]\r\n\r\n';
    const response = sse(text);
    Object.defineProperty(response, 'url', { value: 'http://localhost/final-url' });
    let count = 0;
    const options = init();
    const { host, logger } = fixture(function (url, opts) {
        count++;
        assert.equal(url, requestUrl);
        assert.equal(opts, options);
        assert.equal(this, host);
        return Promise.resolve(response);
    });
    const observed = await host.fetch(requestUrl, options);
    assert.equal(observed.url, response.url);
    assert.equal(observed.status, response.status);
    assert.deepEqual(new Uint8Array(await observed.arrayBuffer()), encoder.encode(text));
    assert.equal(count, 1);
    const [record] = logger.getRecords();
    assert.equal(record.outcome, 'completed');
    assert.equal(record.endMarker, 'done');
    assert.deepEqual(record.finishReasons, ['stop']);
    assert.equal(record.usage.completion_tokens, 12);
    assert.equal(record.request.parameters.max_tokens, 3000);
    assert.equal(record.request.messages.count, 1);
    assert.equal(record.response.bytes, encoder.encode(text).length);
    assert.doesNotMatch(logger.exportJson(), /PRIVATE_PROMPT|PRIVATE_REPLY/);
});

test('observation never pulls ahead of the consumer and forwards cancellation once', async () => {
    let pulls = 0;
    let cancelled;
    const upstream = new ReadableStream({
        pull(controller) { pulls++; controller.enqueue(encoder.encode(': ping\n\n')); },
        cancel(reason) { cancelled = reason; },
    }, { highWaterMark: 0 });
    const { host, logger } = fixture(async () => sse(upstream));
    const response = await host.fetch(requestUrl, init());
    await tick();
    assert.equal(pulls, 0);
    const reader = response.body.getReader();
    await reader.read();
    await tick();
    assert.equal(pulls, 1);
    const reason = new Error('consumer stopped');
    await reader.cancel(reason);
    assert.equal(cancelled, reason);
    assert.equal(logger.getRecords()[0].outcome, 'consumer_cancelled');
});

test('UTF-8 byte splits, CRLF and multiline SSE data retain Claude termination metadata', async () => {
    const text = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"text":"隐私回答🙂"}}\r\n\r\n'
        + 'event: message_delta\ndata: {"delta":{"stop_reason":"max_tokens"},\ndata: "usage":{"output_tokens":3000}}\n\n'
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const bytes = encoder.encode(text);
    let index = 0;
    const body = new ReadableStream({
        pull(controller) {
            if (index === bytes.length) controller.close();
            else controller.enqueue(bytes.slice(index, ++index));
        },
    }, { highWaterMark: 0 });
    const { host, logger } = fixture(async () => sse(body));
    assert.equal(await (await host.fetch(requestUrl, init())).text(), text);
    const [record] = logger.getRecords();
    assert.equal(record.outcome, 'completed');
    assert.equal(record.endMarker, 'message_stop');
    assert.deepEqual(record.finishReasons, ['max_tokens']);
    assert.equal(record.usage.output_tokens, 3000);
    assert.doesNotMatch(logger.exportJson(), /隐私回答/);
});

test('clean EOF without a protocol terminator is not reported as successful completion', async () => {
    const { host, logger } = fixture(async () => sse('data: {"choices":[{"delta":{"content":"reply"}}]}\n\n'));
    await (await host.fetch(requestUrl, init())).text();
    assert.equal(logger.getRecords()[0].outcome, 'eof_without_end_marker');
});

test('a finish_reason without DONE is distinguished from a full protocol end', async () => {
    const { host, logger } = fixture(async () => sse('data: {"choices":[{"finish_reason":"length"}]}\n\n'));
    await (await host.fetch(requestUrl, init())).text();
    assert.equal(logger.getRecords()[0].outcome, 'eof_with_finish_reason');
});

test('SSE errors at HTTP 200 are captured even when followed by DONE', async () => {
    const text = 'event: error\ndata: {"error":{"type":"overloaded_error","message":"Upstream overloaded"}}\n\n'
        + 'data: [DONE]\n\n';
    const { host, logger } = fixture(async () => sse(text));
    assert.equal(await (await host.fetch(requestUrl, init())).text(), text);
    const [record] = logger.getRecords();
    assert.equal(record.outcome, 'api_error');
    assert.equal(record.error.type, 'overloaded_error');
    assert.equal(record.error.message, 'Upstream overloaded');
});

test('HTTP errors and JSON error envelopes are classified without storing response bodies', async () => {
    for (const status of [200, 429, 502]) {
        const data = { error: { code: 'rate_limit', message: 'Rate limit reached', input: 'PRIVATE_PROMPT' },
            content: 'PRIVATE_REPLY', debug: { headers: 'SECRET_HEADER' } };
        const { host, logger } = fixture(async () => json(data, status));
        assert.deepEqual(await (await host.fetch(requestUrl, init())).json(), data);
        const [record] = logger.getRecords();
        assert.equal(record.outcome, status === 200 ? 'api_error' : 'http_error');
        assert.equal(record.response.status, status);
        assert.equal(record.error.code, 'rate_limit');
        assert.doesNotMatch(logger.exportJson(), /PRIVATE_PROMPT|PRIVATE_REPLY|SECRET_HEADER/);
    }
});

test('credentials, raw YAML, free-form parameters, URL query and userinfo are omitted', async () => {
    const apiKey = 'private-key-123';
    const body = { ...baseBody,
        custom_url: 'https://url-user:url-password@provider.example/v1?api_key=QUERY_SECRET#FRAGMENT_SECRET',
        custom_include_headers: 'Authorization: Bearer private-key-123\nX-Custom: HEADER_SECRET',
        proxy_password: 'proxy-secret', temperature: 0.9, top_p: 0.95,
        stop: ['STOP_SECRET'], tools: [{ description: 'TOOL_SECRET' }],
        json_schema: { value: { description: 'SCHEMA_SECRET' } },
        assistant_prefill: 'PREFILL_SECRET', unknown: 'UNKNOWN_SECRET',
        custom_include_body: 'max_tokens: 4096\nreasoning_effort: high\nprompt: YAML_PROMPT_SECRET',
    };
    const { host, logger } = fixture(async () => json({ error: { message:
        `Unauthorized Bearer ${apiKey}; proxy-secret; HEADER_SECRET; input: PRIVATE_PROMPT_DO_NOT_LOG` } }, 401),
    { getSecrets: () => [apiKey] });
    await (await host.fetch(requestUrl, init(body))).text();
    const exported = logger.exportJson();
    for (const secret of [apiKey, 'proxy-secret', 'url-user', 'url-password', 'QUERY_SECRET',
        'FRAGMENT_SECRET', 'STOP_SECRET', 'TOOL_SECRET', 'SCHEMA_SECRET', 'PREFILL_SECRET',
        'UNKNOWN_SECRET', 'YAML_PROMPT_SECRET', 'HEADER_SECRET', 'PRIVATE_PROMPT_DO_NOT_LOG']) {
        assert.ok(!exported.includes(secret), secret);
    }
    const [record] = logger.getRecords();
    assert.equal(record.request.endpoint, 'https://provider.example/v1');
    assert.equal(record.request.parameters.temperature, 0.9);
    assert.equal(record.request.customBody.parameters.max_tokens, 4096);
    assert.equal(record.request.customBody.parameters.reasoning_effort, 'high');
});

test('stream read errors preserve the original error object for the client', async () => {
    const failure = new TypeError('terminated');
    let pulls = 0;
    const body = new ReadableStream({
        pull(controller) {
            if (pulls++ === 0) controller.enqueue(encoder.encode(': ping\n\n'));
            else controller.error(failure);
        },
    }, { highWaterMark: 0 });
    const { host, logger } = fixture(async () => sse(body));
    const response = await host.fetch(requestUrl, init());
    await assert.rejects(response.text(), error => error === failure);
    assert.equal(logger.getRecords()[0].outcome, 'stream_error');
    assert.equal(logger.getRecords()[0].error.message, 'terminated');
});

test('fetch rejection is rethrown unchanged and recorded', async () => {
    const failure = new TypeError('Failed to fetch');
    const { host, logger } = fixture(() => Promise.reject(failure));
    await assert.rejects(host.fetch(requestUrl, init()), error => error === failure);
    assert.equal(logger.getRecords()[0].outcome, 'request_error');
});

test('AbortSignal is never replaced; abort while reading records cancellation, not upstream failure', async () => {
    const controller = new AbortController();
    const failure = new DOMException('The operation was aborted', 'AbortError');
    const { host, logger } = fixture(async (_url, options) => {
        assert.equal(options.signal, controller.signal);
        return sse(new ReadableStream({
            start(stream) {
                options.signal.addEventListener('abort', () => stream.error(failure), { once: true });
            },
        }, { highWaterMark: 0 }));
    });
    const response = await host.fetch(requestUrl, init(baseBody, { signal: controller.signal }));
    const reading = response.text();
    controller.abort('Clicked stop button');
    await assert.rejects(reading, error => error === failure);
    const [record] = logger.getRecords();
    assert.equal(record.outcome, 'aborted');
    assert.equal(record.abortReason.message, 'Clicked stop button');
});

test('unrelated endpoints, sources and non-string bodies stay completely untouched', async () => {
    const response = sse('data: [DONE]\n\n');
    const promise = Promise.resolve(response);
    const { host, logger } = fixture(() => promise);
    assert.equal(host.fetch('http://other.example/api/backends/chat-completions/generate', init()), promise);
    assert.equal(host.fetch('http://localhost/api/settings/save', init()), promise);
    assert.equal(host.fetch(requestUrl, init({ ...baseBody, chat_completion_source: 'openai' })), promise);
    assert.equal(host.fetch(requestUrl, { method: 'POST', body: new Blob(['{}']) }), promise);
    assert.equal(host.fetch(requestUrl, { method: 'POST', body: '{invalid' }), promise);
    assert.deepEqual(logger.getRecords(), []);
});

test('logger or UI callback failures cannot prevent a network request or change response bytes', async () => {
    const text = 'data: [DONE]\n\n';
    const { host, logger } = fixture(async () => sse(text), { onChange() { throw new Error('UI gone'); } });
    assert.equal(await (await host.fetch(requestUrl, init())).text(), text);
    assert.equal(logger.getRecords()[0].outcome, 'completed');
    const skipped = fixture(async () => sse(text), { shouldRecord() { throw new Error('editor missing'); } });
    assert.equal(await (await skipped.host.fetch(requestUrl, init())).text(), text);
    assert.deepEqual(skipped.logger.getRecords(), []);
});

test('clearing and disabling during a pending request do not cancel it or resurrect logs', async () => {
    for (const action of ['clear', 'disable']) {
        let resolve;
        const { host, logger } = fixture(() => new Promise(done => { resolve = done; }));
        const pending = host.fetch(requestUrl, init());
        logger[action]();
        resolve(sse('data: [DONE]\n\n'));
        assert.equal(await (await pending).text(), 'data: [DONE]\n\n');
        if (action === 'clear') assert.deepEqual(logger.getRecords(), []);
        else assert.equal(logger.getRecords()[0].outcome, 'observation_disabled');
    }
});

test('capacity is bounded and concurrent requests have separate outcomes', async () => {
    const resolves = [];
    const { host, logger } = fixture(() => new Promise(resolve => resolves.push(resolve)), { capacity: 2 });
    const requests = [1, 2, 3].map(n => host.fetch(requestUrl, init({ ...baseBody, max_tokens: n })));
    assert.equal(logger.getRecords().length, 2);
    resolves[2](sse('data: [DONE]\n\n'));
    resolves[1](json({ error: { message: 'Overloaded' } }, 503));
    resolves[0](sse('data: [DONE]\n\n'));
    await Promise.all(requests.map(async response => (await response).text()));
    const records = logger.getRecords();
    assert.equal(new Set(records.map(record => record.id)).size, 2);
    assert.deepEqual(records.map(record => record.request.parameters.max_tokens), [2, 3]);
    assert.deepEqual(records.map(record => record.outcome), ['http_error', 'completed']);
});

test('oversized SSE events are skipped with a warning; subsequent terminators are still detected', async () => {
    const text = 'data: {"choices":[{"delta":{"content":"' + 'x'.repeat(200000) + '"}}]}\n\n'
        + 'data: [DONE]\n\n';
    const { host, logger } = fixture(async () => sse(text));
    assert.equal(await (await host.fetch(requestUrl, init())).text(), text);
    const [record] = logger.getRecords();
    assert.equal(record.outcome, 'completed');
    assert.ok(record.warnings.includes('event_size_limit'));
    assert.ok(logger.exportJson().length < 15000);
});

test('SillyTavern streams without Content-Type are detected from split SSE prefixes', async () => {
    const chunks = ['da', 'ta: {"choices":[{"delta":{"content":"PRIVATE_REPLY"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'];
    let i = 0;
    const { host, logger } = fixture(async () => new Response(new ReadableStream({
        pull(controller) {
            if (i === chunks.length) controller.close();
            else controller.enqueue(encoder.encode(chunks[i++]));
        },
    }, { highWaterMark: 0 })));
    assert.equal(await (await host.fetch(requestUrl, init())).text(), chunks.join(''));
    const [record] = logger.getRecords();
    assert.equal(record.outcome, 'completed');
    assert.equal(record.endMarker, 'done');
    assert.equal(record.response.detectedFormat, 'sse');
    assert.ok(record.warnings.includes('sse_without_content_type'));
    assert.doesNotMatch(logger.exportJson(), /PRIVATE_REPLY/);
});

test('expected SSE receiving a headerless JSON error still extracts the error', async () => {
    const { host, logger } = fixture(async () => new Response('{"error":{"message":"Upstream timeout"}}'));
    await (await host.fetch(requestUrl, init())).text();
    const [record] = logger.getRecords();
    assert.equal(record.outcome, 'api_error');
    assert.equal(record.error.message, 'Upstream timeout');
});

test('non-SSE successful JSON when stream was requested is not marked complete', async () => {
    const { host, logger } = fixture(async () => json({ choices: [{ message: { content: 'PRIVATE_REPLY' } }] }));
    await (await host.fetch(requestUrl, init())).json();
    assert.equal(logger.getRecords()[0].outcome, 'unexpected_non_sse');
});

test('an SSE error is exportable immediately even if the connection never closes', async () => {
    let pushes = 0;
    const { host, logger } = fixture(async () => sse(new ReadableStream({
        pull(controller) {
            if (pushes++ === 0) controller.enqueue(encoder.encode('event: error\ndata: {"error":{"message":"Overloaded"}}\n\n'));
        },
    }, { highWaterMark: 0 })));
    const response = await host.fetch(requestUrl, init());
    const reader = response.body.getReader();
    await reader.read();
    assert.equal(logger.getRecords()[0].outcome, 'api_error');
    assert.equal(logger.getRecords()[0].error.message, 'Overloaded');
    await reader.cancel();
});

test('consumer cancel while a read is pending forwards the reason without unhandled errors', async () => {
    let cancellation;
    const { host, logger } = fixture(async () => sse(new ReadableStream({
        cancel(reason) { cancellation = reason; },
    }, { highWaterMark: 0 })));
    const response = await host.fetch(requestUrl, init());
    const reader = response.body.getReader();
    const pending = reader.read();
    await tick();
    await reader.cancel('test cancellation');
    assert.equal((await pending).done, true);
    assert.equal(cancellation, 'test cancellation');
    assert.equal(logger.getRecords()[0].outcome, 'consumer_cancelled');
});

test('quoted JSON request echoes in error messages are omitted', async () => {
    const message = 'invalid request: {"messages": [{"content": "ECHOED_PRIVATE_FRAGMENT"}]}';
    const { host, logger } = fixture(async () => json({ error: { message } }, 400));
    await (await host.fetch(requestUrl, init())).json();
    assert.doesNotMatch(logger.exportJson(), /ECHOED_PRIVATE_FRAGMENT/);
});

test('transport failures after an API error retain both diagnostic causes', async () => {
    let count = 0;
    const { host, logger } = fixture(async () => sse(new ReadableStream({
        pull(controller) {
            if (count++ === 0) controller.enqueue(encoder.encode('data: {"error":{"message":"Overloaded"}}\n\n'));
            else controller.error(new TypeError('terminated'));
        },
    }, { highWaterMark: 0 })));
    await assert.rejects((await host.fetch(requestUrl, init())).text(), /terminated/);
    const [record] = logger.getRecords();
    assert.equal(record.error.message, 'Overloaded');
    assert.equal(record.transportError.message, 'terminated');
});

test('restored records and new requests have distinct persistent IDs', async () => {
    const history = [{ id: 'old-page-1', startedAt: new Date().toISOString(), outcome: 'completed', inFlight: false }];
    const { host, logger } = fixture(async () => sse('data: [DONE]\n\n'), { initialRecords: history });
    assert.equal(logger.count, 1);
    await (await host.fetch(requestUrl, init())).text();
    assert.equal(logger.count, 2);
    assert.equal(logger.getRecords()[0].id, 'old-page-1');
    assert.equal(typeof logger.getRecords()[1].id, 'string');
    assert.notEqual(logger.getRecords()[1].id, 'old-page-1');
    assert.equal(logger.getRecords()[1].inFlight, false);
    assert.equal(history.length, 1);
});

test('progress snapshots are bounded and only emitted as the consumer reads', async () => {
    let time = 0;
    let changes = 0;
    const { host, logger } = fixture(async () => sse(new ReadableStream({
        pull(controller) { controller.enqueue(encoder.encode(': ping\n\n')); },
    }, { highWaterMark: 0 })), { clock: () => time, onChange() { changes++; } });
    const response = await host.fetch(requestUrl, init());
    const reader = response.body.getReader();
    changes = 0;
    for (let i = 0; i < 10; i++) { time += 100; await reader.read(); }
    assert.equal(changes, 0);
    time = 5100;
    await reader.read();
    assert.equal(changes, 1);
    assert.equal(logger.getRecords()[0].response.lastByteMs, 5100);
    assert.equal(logger.getRecords()[0].inFlight, true);
    await reader.cancel();
    assert.equal(logger.getRecords()[0].inFlight, false);
});

test('browser exceptions during an active request are bounded, redacted and never suppressed', async () => {
    const host = new EventTarget();
    let complete;
    host.fetch = () => new Promise(resolve => { complete = resolve; });
    const logger = createDiagnostics({ host, baseUrl: 'http://localhost/', shouldRecord: () => true,
        getSecrets: () => ['SECRET_API_KEY'] });
    logger.enable();
    const pending = host.fetch(requestUrl, init());
    const event = new Event('error', { cancelable: true });
    event.error = new Error('Failed SECRET_API_KEY input: PRIVATE_PROMPT_DO_NOT_LOG');
    event.error.stack = 'Error: secret\n    at render (http://localhost/script.js?token=SECRET_API_KEY:123:4)';
    host.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    const errors = logger.getRecords()[0].browserErrors;
    assert.equal(errors.length, 1);
    assert.equal(errors[0].kind, 'error');
    assert.doesNotMatch(logger.exportJson(), /SECRET_API_KEY|PRIVATE_PROMPT_DO_NOT_LOG/);
    for (let i = 0; i < 10; i++) host.dispatchEvent(new Event('unhandledrejection'));
    assert.ok(logger.getRecords()[0].browserErrors.length <= 5);
    complete(sse('data: [DONE]\n\n'));
    await (await pending).text();
    const count = logger.getRecords()[0].browserErrors.length;
    host.dispatchEvent(event);
    assert.equal(logger.getRecords()[0].browserErrors.length, count);
    logger.disable();
});

test('disabling does not overwrite a fetch wrapper installed later by another extension', async () => {
    const { host, logger } = fixture(async () => sse('data: [DONE]\n\n'));
    const ours = host.fetch;
    const other = (...args) => ours.apply(host, args);
    host.fetch = other;
    logger.disable();
    assert.equal(host.fetch, other);
    assert.equal(await (await host.fetch(requestUrl, init())).text(), 'data: [DONE]\n\n');
    assert.deepEqual(logger.getRecords(), []);
    logger.enable();
    await (await host.fetch(requestUrl, init())).text();
    assert.equal(logger.getRecords().length, 1);
});