// Browser-only diagnostics. No SillyTavern imports, storage, timers or network requests.
const GENERATE_PATH = '/api/backends/chat-completions/generate';
const BUFFER_LIMIT = 64 * 1024;
const NUMBER_PARAMS = new Set([
    'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k', 'min_p',
    'top_a', 'typical_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty',
    'seed', 'n', 'logprobs', 'top_logprobs', 'thinking_budget',
]);
const BOOLEAN_PARAMS = new Set([
    'stream', 'include_reasoning', 'use_sysprompt', 'enable_web_search', 'request_images',
]);
const ENUM_PARAMS = {
    reasoning_effort: ['auto', 'none', 'min', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh'],
    verbosity: ['auto', 'low', 'medium', 'high'],
    custom_prompt_post_processing: ['', 'merge', 'merge_tools', 'semi', 'semi_tools',
        'strict', 'strict_tools', 'single'],
    tool_choice: ['auto', 'none', 'required'],
};
const USAGE_KEYS = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens',
    'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const FINISH_REASONS = new Set(['stop', 'length', 'end_turn', 'max_tokens', 'tool_calls',
    'function_call', 'tool_use', 'stop_sequence', 'pause_turn', 'refusal', 'content_filter', 'safety']);

function parameters(body) {
    const result = {};
    for (const key of NUMBER_PARAMS) {
        if (Number.isFinite(body?.[key])) result[key] = body[key];
    }
    for (const key of BOOLEAN_PARAMS) {
        if (typeof body?.[key] === 'boolean') result[key] = body[key];
    }
    for (const [key, values] of Object.entries(ENUM_PARAMS)) {
        if (values.includes(body?.[key])) result[key] = body[key];
    }
    if (body?.thinking && typeof body.thinking === 'object') {
        result.thinking = {};
        if (['enabled', 'disabled', 'adaptive'].includes(body.thinking.type)) result.thinking.type = body.thinking.type;
        if (Number.isFinite(body.thinking.budget_tokens)) result.thinking.budget_tokens = body.thinking.budget_tokens;
    }
    return result;
}

// YAML remains the server's responsibility: only flat, explicitly allowlisted scalars are logged.
function customBodySummary(text) {
    const values = {};
    if (typeof text === 'string') {
        for (const line of text.slice(0, BUFFER_LIMIT).split('\n')) {
            const match = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
            if (!match) continue;
            const [, key, raw] = match;
            if (NUMBER_PARAMS.has(key) && /^-?\d+(?:\.\d+)?$/.test(raw)) values[key] = Number(raw);
            else if (BOOLEAN_PARAMS.has(key) && /^(true|false)$/.test(raw)) values[key] = raw === 'true';
            else if (ENUM_PARAMS[key]) values[key] = raw.replace(/^['"]|['"]$/g, '');
        }
    }
    return { present: Boolean(text), parameters: parameters(values), scope: 'allowlisted_flat_scalars_only' };
}

function safeEndpoint(value, clean) {
    try {
        const url = new URL(value);
        return clean(url.origin + url.pathname).slice(0, 400);
    } catch { return '[invalid_or_missing_url]'; }
}

function makeRedactor(body, init, extraSecrets) {
    const secrets = new Set();
    const privateText = new Set();
    const addSecret = value => {
        if (typeof value === 'string' && value && secrets.size < 256) {
            secrets.add(value);
            const bearer = /^Bearer\s+(.+)$/i.exec(value);
            if (bearer) secrets.add(bearer[1]);
        }
    };
    for (const value of extraSecrets || []) addSecret(value);
    addSecret(body.proxy_password);
    addSecret(body.secret_id);
    for (const line of String(body.custom_include_headers || '').split('\n')) {
        const colon = line.indexOf(':');
        if (colon >= 0) addSecret(line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, ''));
    }
    if (init.headers) new Headers(init.headers).forEach(value => addSecret(value));
    for (const value of [body.custom_url, body.reverse_proxy]) {
        try {
            const url = new URL(value);
            addSecret(decodeURIComponent(url.username));
            addSecret(decodeURIComponent(url.password));
            url.searchParams.forEach(item => addSecret(item));
            addSecret(url.hash.slice(1));
        } catch { /* Invalid endpoints must not break the request. */ }
    }
    let visited = 0;
    function collect(value, depth = 0) {
        if (++visited > 4096 || depth > 10) return;
        if (typeof value === 'string' && value.length >= 8 && privateText.size < 256) privateText.add(value);
        else if (Array.isArray(value)) value.forEach(item => collect(item, depth + 1));
        else if (value && typeof value === 'object') Object.values(value).forEach(item => collect(item, depth + 1));
    }
    for (const key of ['messages', 'prompt', 'system', 'tools', 'json_schema', 'stop', 'assistant_prefill']) collect(body[key]);
    const masks = [...secrets, ...privateText].sort((a, b) => b.length - a.length);
    return value => {
        let text = String(value ?? '');
        // Error messages sometimes echo the supplied credentials or request text.
        for (const mask of masks) text = text.split(mask).join('[redacted]');
        // JSON/YAML credentials can contain spaces and quoted keys; mask whole values before token patterns.
        text = text.replace(/((?:api[_-]?key|authorization|password|token|secret)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1[redacted]');
        text = text.replace(/https?:\/\/[^\s<>"']+/gi, url => {
            try { const parsed = new URL(url); return parsed.origin + parsed.pathname; }
            catch { return '[url]'; }
        });
        text = text.replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
            .replace(/\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
            .replace(/((?:api[_-]?key|authorization|password|token|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
            .replace(/((?:messages|prompt|input|content|system|thinking)["']?\s*[=:]\s*)[\s\S]*/gi, '$1[omitted]');
        return text.slice(0, 768);
    };
}

function errorSummary(error, clean) {
    if (typeof error === 'string') return { message: clean(error) };
    const result = {};
    if (error && typeof error === 'object') {
        for (const key of ['name', 'type', 'code', 'message']) {
            const value = error[key];
            if (typeof value === 'string' || typeof value === 'number') result[key] = clean(value);
        }
    }
    if (!Object.keys(result).length) result.message = 'Upstream returned an error without details';
    return result;
}

function requestSummary(body, clean) {
    const roles = {};
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
        const role = ['system', 'user', 'assistant', 'tool', 'function', 'developer'].includes(message?.role)
            ? message.role : 'other';
        roles[role] = (roles[role] || 0) + 1;
    }
    return {
        source: clean(body.chat_completion_source).slice(0, 40),
        model: clean(body.model).slice(0, 180),
        endpoint: safeEndpoint(body.custom_url || body.reverse_proxy, clean),
        parameters: parameters(body),
        messages: { count: Array.isArray(body.messages) ? body.messages.length : 0, roles },
        toolsCount: Array.isArray(body.tools) ? body.tools.length : 0,
        stopCount: Array.isArray(body.stop) ? body.stop.length : Number(Boolean(body.stop)),
        jsonSchemaPresent: Boolean(body.json_schema),
        customBody: customBodySummary(body.custom_include_body),
        // Names are filtered too: an arbitrary YAML key could itself contain private text.
        customExclude: [...NUMBER_PARAMS, ...BOOLEAN_PARAMS, ...Object.keys(ENUM_PARAMS)]
            .filter(key => String(body.custom_exclude_body || '').split('\n')
                .some(line => line.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g, '') === key)),
        customHeadersPresent: Boolean(body.custom_include_headers),
        scope: 'browser_to_sillytavern_not_final_provider_body',
    };
}

function responseInspector(record, stream, expectedStream, clean, finish, warning, reportError) {
    const decoder = new TextDecoder();
    let buffer = '';
    let line = '';
    let lineLength = 0;
    let event = '';
    let data = '';
    let discard = false;
    let previousCR = false;
    let stopped = false;
    let sniff = '';
    let malformed = false;

    function metadata(value) {
        if (!value || typeof value !== 'object') return;
        const error = value.error || value.detail?.error
            || (value.type === 'error' ? value : null);
        if (error) {
            record.error = errorSummary(error === true ? value : error, clean);
            reportError();
        }
        const reasons = [value.stop_reason, value.delta?.stop_reason,
            ...(Array.isArray(value.choices) ? value.choices.slice(0, 16).map(choice => choice?.finish_reason) : [])];
        for (const reason of reasons.filter(Boolean)) {
            const safe = FINISH_REASONS.has(reason) ? reason : '[other]';
            if (!record.finishReasons.includes(safe)) record.finishReasons.push(safe);
        }
        for (const usage of [value.usage, value.message?.usage]) {
            for (const key of USAGE_KEYS) {
                if (Number.isFinite(usage?.[key])) record.usage[key] = usage[key];
            }
            if (Number.isFinite(usage?.completion_tokens_details?.reasoning_tokens)) {
                record.usage.reasoning_tokens = usage.completion_tokens_details.reasoning_tokens;
            }
        }
    }
    function eventEnd() {
        if (!discard && (data || event)) {
            record.response.events++;
            const raw = data.trim();
            if (raw === '[DONE]') record.endMarker = 'done';
            else {
                let value;
                try { value = raw ? JSON.parse(raw) : null; }
                catch { malformed = true; warning('invalid_sse_json'); }
                metadata(value);
                if (event === 'error' && !record.error) {
                    record.error = { type: 'sse_error', message: 'SSE error event; unstructured body omitted' };
                    reportError();
                }
                if (event === 'message_stop' || value?.type === 'message_stop') record.endMarker = 'message_stop';
            }
        }
        data = ''; event = ''; discard = false;
        if (record.endMarker) finish(record.error ? 'api_error' : malformed ? 'malformed_sse' : 'completed');
    }
    function lineEnd() {
        if (lineLength === 0) eventEnd();
        else if (!discard) {
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') event = value;
            if (field === 'data') {
                if (data.length + value.length + 1 > BUFFER_LIMIT) {
                    discard = true; data = ''; warning('event_size_limit');
                } else data += value + '\n';
            }
        }
        line = ''; lineLength = 0;
    }
    function accept(text) {
        if (stopped) return;
        // ST's forwardFetchResponse can omit Content-Type. Wait for a bounded prefix,
        // rather than treating every response to stream:true as SSE (errors may be JSON).
        if (stream === null) {
            sniff += text;
            const prefix = sniff.trimStart();
            const fields = ['data:', 'event:', 'id:', 'retry:', ':'];
            if (fields.some(field => prefix.startsWith(field))) {
                stream = true;
                warning('sse_without_content_type');
            } else if ((prefix && !fields.some(field => field.startsWith(prefix))) || sniff.length >= 256) {
                stream = false;
            } else return;
            record.response.detectedFormat = stream ? 'sse' : 'non_sse';
            text = sniff;
            sniff = '';
        }
        if (!stream) {
            if (!discard && buffer.length + text.length <= BUFFER_LIMIT) buffer += text;
            else { discard = true; buffer = ''; warning('non_sse_body_limit'); }
            return;
        }
        for (const character of text) {
            if (stopped) break;
            if (previousCR) {
                previousCR = false;
                if (character === '\n') continue;
            }
            if (character === '\r' || character === '\n') {
                lineEnd(); previousCR = character === '\r';
            } else {
                lineLength++;
                if (!discard && lineLength <= BUFFER_LIMIT) line += character;
                else if (!discard) { discard = true; line = ''; data = ''; warning('event_size_limit'); }
            }
        }
    }
    return {
        bytes(chunk) {
            // Decode in bounded windows; no tee/clone and no raw stream retained after inspection.
            for (let offset = 0; offset < chunk.byteLength && !stopped; offset += 8192) {
                accept(decoder.decode(chunk.subarray(offset, offset + 8192), { stream: true }));
            }
        },
        end() {
            accept(decoder.decode());
            if (stream === null) {
                stream = false;
                buffer = sniff;
                sniff = '';
                record.response.detectedFormat = 'non_sse';
            }
            if (stream) {
                // An unterminated SSE event is not a reliable completion signal.
                if (lineLength || data) warning('incomplete_sse_event');
                finish(record.error ? 'api_error' : malformed ? 'malformed_sse' : record.finishReasons.length
                    ? 'eof_with_finish_reason' : 'eof_without_end_marker');
            } else {
                let value;
                try { value = JSON.parse(buffer); } catch { /* Never log an HTML page or raw reply. */ }
                metadata(value);
                const isChatResponse = Array.isArray(value?.choices) && value.choices.length > 0
                    || value?.type === 'message' && Array.isArray(value.content);
                finish(record.error ? 'api_error' : discard ? 'body_not_inspected'
                    : expectedStream ? 'unexpected_non_sse' : isChatResponse ? 'completed' : 'unexpected_response');
            }
        },
        stop() { stopped = true; buffer = ''; line = ''; data = ''; event = ''; sniff = ''; },
    };
}

/** Opt-in observer; persistence is delegated to the panel, never a network endpoint. */
export function createDiagnostics({ host = globalThis, baseUrl = globalThis.location?.href,
    shouldRecord = () => false, getSecrets = () => [], onChange = () => {}, capacity = 30,
    initialRecords = [], clock = () => performance.now() } = {}) {
    const limit = Math.max(1, Math.min(50, Math.trunc(capacity) || 30));
    const records = structuredClone(initialRecords.slice(-limit));
    const active = new Map();
    let enabled = false;
    let wrapper = null;
    let delegate = null;
    let sequence = 0;
    const session = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = clock;
    const notify = () => { try { onChange(); } catch { /* Diagnostics UI must not affect generation. */ } };

    function browserError(event) {
        // Temporal correlation only: another extension can throw during generation.
        for (const observation of active.values()) observation.browserError(event);
    }

    function begin(body, init) {
        const clean = makeRedactor(body, init, getSecrets());
        const expectedStream = body.stream === true;
        const start = now();
        let lastProgress = start;
        let lastByte = null;
        let inspector;
        let observing = true;
        const signal = init.signal;
        const record = {
            id: `${session}-${++sequence}`, startedAt: new Date().toISOString(), outcome: 'pending', inFlight: true,
            request: requestSummary(body, clean), response: { bytes: 0, chunks: 0, events: 0 },
            finishReasons: [], usage: {}, warnings: [],
        };
        function changed() {
            record.updatedAt = new Date().toISOString();
            notify();
        }
        function finish(outcome) {
            if (!observing) return;
            record.outcome = record.response.status >= 400 && !['aborted', 'consumer_cancelled', 'observation_disabled'].includes(outcome)
                ? 'http_error' : outcome;
            record.durationMs = Math.round(now() - start);
            stop();
            changed();
        }
        function stop() {
            observing = false;
            record.inFlight = false;
            inspector?.stop();
            signal?.removeEventListener('abort', abort);
            active.delete(record.id);
        }
        function abort() {
            if (!observing) return;
            record.abortReason = errorSummary(signal.reason || 'AbortSignal triggered', clean);
            finish('aborted');
        }
        function warning(message) {
            if (!record.warnings.includes(message)) record.warnings.push(message);
        }
        function reportError() {
            record.outcome = record.response.status >= 400 ? 'http_error' : 'api_error';
            changed();
        }
        function guarded(action) {
            if (!observing) return;
            try { action(); }
            catch {
                // A diagnostic parser failure is not a transport failure. Forward bytes as usual.
                warning('observer_failed');
                finish('observation_failed');
            }
        }
        const observation = {
            record, start,
            get lastByte() { return lastByte; },
            get observing() { return observing; },
            stop, finish,
            response(response) {
                guarded(() => {
                    record.response.status = response.status;
                    record.response.contentType = clean(response.headers.get('content-type') || '').slice(0, 120);
                    for (const name of ['x-request-id', 'request-id', 'cf-ray']) {
                        if (response.headers.has(name)) (record.response.requestIds ??= {})[name] = clean(response.headers.get(name));
                    }
                    const isSSE = /text\/event-stream/i.test(record.response.contentType) ? true : expectedStream ? null : false;
                    record.response.detectedFormat = isSSE === null ? 'pending' : isSSE ? 'sse' : 'non_sse';
                    inspector = responseInspector(record, isSSE, expectedStream, clean, finish, warning, reportError);
                    record.response.headersMs = Math.round(now() - start);
                    changed();
                });
            },
            bytes(chunk) {
                guarded(() => {
                    const time = now();
                    if (lastByte === null) record.response.firstByteMs = Math.round(time - start);
                    else record.response.maxGapMs = Math.max(record.response.maxGapMs || 0, Math.round(time - lastByte));
                    lastByte = time;
                    record.response.lastByteMs = Math.round(time - start);
                    record.response.bytes += chunk.byteLength;
                    record.response.chunks++;
                    inspector?.bytes(chunk);
                    // Progress snapshots are driven by actual reads, not polling or extra stream consumers.
                    if (observing && time - lastProgress >= 5000) {
                        lastProgress = time;
                        changed();
                    }
                });
            },
            browserError(event) {
                guarded(() => {
                    if ((record.browserErrors?.length || 0) >= 5) return;
                    const error = event.type === 'unhandledrejection' ? event.reason : event.error;
                    const detail = errorSummary(error || event.message || 'Browser error without details', clean);
                    // Only bounded source locations, not the free-form first stack line, are retained.
                    if (typeof error?.stack === 'string') {
                        detail.frames = error.stack.split('\n').slice(1, 7).map(frame => {
                            const location = frame.match(/https?:\/\/[^\s)]+/);
                            return location ? clean(location[0]) : '[frame omitted]';
                        });
                    }
                    (record.browserErrors ??= []).push({ kind: event.type, atMs: Math.round(now() - start), ...detail });
                    changed();
                });
            },
            end() { guarded(() => inspector ? inspector.end() : finish('empty_response')); },
            error(error, outcome) {
                guarded(() => {
                    const detail = errorSummary(error, clean);
                    if (record.error) record.transportError = detail;
                    else record.error = detail;
                    finish(signal?.aborted ? 'aborted' : outcome);
                });
            },
            cancel() { guarded(() => finish('consumer_cancelled')); },
        };
        if (records.length === limit) {
            const evicted = records.shift();
            active.get(evicted.id)?.stop();
        }
        records.push(record);
        active.set(record.id, observation);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        changed();
        return observation;
    }

    function observeResponse(response, observation) {
        if (!observation.observing) return response;
        observation.response(response);
        if (!response.body) { observation.finish('empty_response'); return response; }
        if (response.bodyUsed || response.body.locked) {
            observation.finish('body_unavailable');
            return response;
        }
        let reader;
        try {
            reader = response.body.getReader();
            const body = new ReadableStream({
                async pull(controller) {
                    try {
                        const result = await reader.read();
                        if (result.done) {
                            observation.end(); controller.close(); reader.releaseLock();
                        } else {
                            observation.bytes(result.value);
                            controller.enqueue(result.value);
                        }
                    } catch (error) {
                        observation.error(error, 'stream_error');
                        controller.error(error);
                        reader.releaseLock();
                    }
                },
                async cancel(reason) {
                    observation.cancel();
                    try { await reader.cancel(reason); }
                    finally { reader.releaseLock(); }
                },
            }, { highWaterMark: 0 });
            const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
            // The ST consumer uses status/body; preserve other standard metadata for adjacent wrappers.
            for (const key of ['url', 'redirected', 'type']) {
                Object.defineProperty(result, key, { value: response[key], configurable: true });
            }
            return result;
        } catch {
            reader?.releaseLock();
            observation.finish('observation_unavailable');
            return response;
        }
    }

    function enable() {
        if (enabled) return;
        const previous = host.fetch;
        const installed = function (...args) {
            if (!enabled || wrapper !== installed) return Reflect.apply(previous, this, args);
            let observation;
            try {
                const [input, init] = args;
                const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, baseUrl);
                const origin = new URL(baseUrl).origin;
                if (url.origin === origin && url.pathname === GENERATE_PATH
                    && String(init?.method || '').toUpperCase() === 'POST' && typeof init?.body === 'string') {
                    const body = JSON.parse(init.body);
                    if (body && shouldRecord(body)) observation = begin(body, init);
                }
            } catch { /* Unsupported arguments or unavailable editor: keep fetch unchanged. */ }
            if (!observation) return Reflect.apply(previous, this, args);
            try {
                return Reflect.apply(previous, this, args).then(
                    response => observeResponse(response, observation),
                    error => { observation.error(error, 'request_error'); throw error; },
                );
            } catch (error) {
                observation.error(error, 'request_error');
                throw error;
            }
        };
        host.fetch = installed;
        delegate = previous;
        wrapper = installed;
        enabled = true;
        try {
            host.addEventListener?.('error', browserError);
            host.addEventListener?.('unhandledrejection', browserError);
        } catch { /* Non-browser hosts may not expose global events. */ }
        notify();
    }
    function disable() {
        enabled = false;
        if (host.fetch === wrapper) host.fetch = delegate;
        try {
            host.removeEventListener?.('error', browserError);
            host.removeEventListener?.('unhandledrejection', browserError);
        } catch { /* Best effort on non-browser hosts. */ }
        for (const observation of [...active.values()]) observation.finish('observation_disabled');
        notify();
    }
    function clear() {
        for (const observation of [...active.values()]) observation.stop();
        records.length = 0;
        notify();
    }
    function getRecords() {
        return records.map(record => {
            const copy = structuredClone(record);
            const observation = active.get(record.id);
            if (observation) {
                copy.durationMs = Math.round(now() - observation.start);
                if (observation.lastByte !== null) copy.idleMs = Math.round(now() - observation.lastByte);
            }
            return copy;
        });
    }
    return {
        enable, disable, clear, getRecords,
        get enabled() { return enabled; },
        get count() { return records.length; },
        exportJson() {
            return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(),
                scope: 'ConnexHub browser-to-SillyTavern diagnostics; provider-side transformations are not observable',
                retention: `Last ${limit} request summaries; panel may persist locally for up to 7 days; no raw bodies or authentication headers`,
                records: getRecords() }, null, 2);
        },
    };
}
