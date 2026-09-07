import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
// Only module boundaries are stubbed; initialization, draft collection, gating and cleanup are production code.
const executable = source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    .replace("await import('./diagnostics-panel.js')", 'await __loadDiagnostics()');
function setup({ failImport = false, failDispose = false } = {}) {
    const events = [];
    const removed = [];
    const fields = { '#cxh_conn_select': '', '#cxh_format': 'openai' };
    let initialization;
    let callbacks;
    let disposed = false;
    let settingsSaves = 0;
    const store = { enabled: true, viewMode: 'cxh', initialized: true, selectedConnectionId: null, connections: [] };
    const node = { style: {}, dataset: {}, addEventListener() {}, contains() { return false; } };
    const context = {
        extension_settings: { connexHub: store }, main_api: 'openai', oai_settings: {},
        chat_completion_sources: { CUSTOM: 'custom', CLAUDE: 'claude' },
        SECRET_KEYS: { CLAUDE: 'claude' }, secret_state: {}, deleteSecret() {},
        saveSettingsDebounced() { settingsSaves++; }, getRequestHeaders: () => ({}),
        event_types: { CHAT_COMPLETION_SETTINGS_READY: 'settings_ready' },
        eventSource: { on: (...args) => events.push(['on', ...args]), makeLast: (...args) => events.push(['last', ...args]) },
        console: { log() {}, error() {}, warn() {} }, structuredClone,
        localStorage: { removeItem: key => removed.push(key) },
        document: { body: { appendChild() {} }, getElementById() { return node; }, addEventListener() {} },
        window: {},
        renderExtensionTemplateAsync: async () => '<fixture/>',
        __loadDiagnostics: async () => {
            assert.ok(events.some(([method, name]) => method === 'on' && name === 'settings_ready'));
            if (failImport) throw new Error('module unavailable');
            return { mountDiagnosticsPanel(root, options) {
                callbacks = options;
                return { dispose() { disposed = true; if (failDispose) throw new Error('broken UI'); } };
            } };
        },
        jQuery: callback => { initialization = callback(); },
        $(selector) {
            const chain = { length: 0,
                val(value) { if (arguments.length) { fields[selector] = value; return chain; } return fields[selector]; },
                text(value) { fields[selector] = value; return chain; },
                prop(name, value) { fields[selector + ':' + name] = value; return chain; },
                each() {}, on() { return chain; }, trigger() { return chain; }, prepend() { return chain; },
                append() { return chain; }, children() { return chain; }, not() { return chain; },
                addClass() { return chain; }, removeClass() { return chain; }, hide() { return chain; },
                show() { return chain; }, attr() { return chain; } };
            return chain;
        },
    };
    vm.createContext(context);
    vm.runInContext(executable, context, { timeout: 1000 });
    return { context, ready: initialization, events, fields, store, removed,
        get callbacks() { return callbacks; }, get disposed() { return disposed; }, get settingsSaves() { return settingsSaves; } };
}

test('actual entry loads diagnostics after chat hooks; only matching ConnexHub requests are observed', async () => {
    const f = setup();
    await f.ready;
    assert.equal(f.events.length, 2);
    f.fields['#cxh_endpoint'] = 'https://provider.invalid/v1#';
    f.fields['#cxh_apikey'] = 'dummy-not-a-real-key';
    f.fields['#cxh_model_input'] = 'claude-opus-4-5';
    f.fields['#cxh_format'] = 'openai';
    const body = { chat_completion_source: 'custom', custom_url: 'https://provider.invalid/v1',
        model: 'claude-opus-4-5', stream: true, messages: [] };
    assert.equal(f.callbacks.shouldRecord(body), true);
    assert.equal(f.callbacks.shouldRecord({ ...body, custom_url: 'https://other.invalid/v1' }), false);
    assert.equal(f.callbacks.shouldRecord({ ...body, chat_completion_source: 'claude' }), false);
    for (const toggle of ['enabled', 'viewMode']) {
        const old = f.store[toggle];
        f.store[toggle] = toggle === 'enabled' ? false : 'native';
        assert.equal(f.callbacks.shouldRecord(body), false);
        f.store[toggle] = old;
    }
    f.context.main_api = 'textgenerationwebui';
    assert.equal(f.callbacks.shouldRecord(body), false);
    f.context.main_api = 'openai';
    f.fields['#cxh_format'] = 'claude';
    f.fields['#cxh_endpoint'] = 'https://provider.invalid/v1';
    assert.equal(f.callbacks.shouldRecord({ chat_completion_source: 'claude', reverse_proxy: 'https://provider.invalid/v1' }), true);
    assert.equal(f.callbacks.getSecrets()[0], 'dummy-not-a-real-key');
    await f.context.cleanupPluginData();
    assert.equal(f.disposed, true);
    assert.equal(f.context.extension_settings.connexHub, undefined);
    assert.ok(f.removed.includes('connexHub.diagnostics.logs.v1'));
});

test('a failed diagnostics module does not prevent original generation hooks or cleanup', async () => {
    const f = setup({ failImport: true });
    await f.ready;
    assert.equal(f.events[0][1], 'settings_ready');
    assert.equal(typeof f.events[0][2], 'function');
    assert.equal(f.fields['#cxh_diagnostics_enabled:disabled'], true);
    assert.match(f.fields['#cxh_diagnostics_status'], /加载失败/);
    await f.context.cleanupPluginData();
    assert.equal(f.context.extension_settings.connexHub, undefined);
    assert.equal(f.settingsSaves, 1);
});

test('diagnostics disposal failure cannot block plugin settings cleanup', async () => {
    const f = setup({ failDispose: true });
    await f.ready;
    await f.context.cleanupPluginData();
    assert.equal(f.context.extension_settings.connexHub, undefined);
    assert.ok(f.removed.includes('connexHub.diagnostics.logs.v1'));
});