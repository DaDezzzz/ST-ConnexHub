import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountDiagnosticsPanel } from '../diagnostics-panel.js';
import { LOGS_KEY, ENABLED_KEY } from '../diagnostics-store.js';

const requestUrl = 'http://localhost/api/backends/chat-completions/generate';
const options = { method: 'POST', body: JSON.stringify({ chat_completion_source: 'custom',
    custom_url: 'https://provider.invalid/v1', model: 'claude-opus-4-5', stream: true,
    messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] }) };
const payload = 'data: {"choices":[{"delta":{"content":"PRIVATE_REPLY"}}]}\n\n'
    + 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
function setup({ items = new Map(), fetchImpl, denied = false, exportFails = false, missing = false } = {}) {
    const listeners = new Map();
    const nodes = Object.fromEntries(['enabled', 'export', 'clear', 'status'].map(name => [name, {
        checked: false, disabled: false, textContent: '', closest: selector => selector === '#cxh_diagnostics_' + name,
    }]));
    const host = new EventTarget();
    host.fetch = fetchImpl || (async () => new Response(payload, { headers: { 'content-type': 'text/event-stream' } }));
    const original = host.fetch;
    const links = [];
    const storage = { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value),
        removeItem: key => items.delete(key) };
    const root = {
        querySelector: selector => missing ? null : nodes[selector.replace('#cxh_diagnostics_', '')],
        addEventListener: (event, callback) => listeners.set(event, callback),
        removeEventListener: event => listeners.delete(event),
        ownerDocument: {
            body: { appendChild(link) { link.attached = true; } },
            createElement() {
                const link = { click() { if (exportFails) throw new Error('download blocked'); link.clicked = true; },
                    remove() { link.removed = true; } };
                links.push(link);
                return link;
            },
        },
    };
    const panel = mountDiagnosticsPanel(root, { host, baseUrl: 'http://localhost/', shouldRecord: () => true,
        getStorage() { if (denied) throw new Error('storage blocked'); return storage; } });
    return { nodes, host, original, panel, links, items, root,
        toggle(value) { nodes.enabled.checked = value; listeners.get('change')({ target: nodes.enabled }); },
        click(name) { listeners.get('click')({ target: nodes[name] }); },
    };
}

test('panel stays off until consent, saves send/receive summaries and exports an actual JSON blob', async () => {
    const f = setup();
    try {
        assert.equal(f.nodes.enabled.checked, false);
        assert.equal(f.host.fetch, f.original);
        assert.equal(f.nodes.export.disabled, true);
        f.toggle(true);
        assert.equal(f.items.get(ENABLED_KEY), 'true');
        const response = f.host.fetch(requestUrl, options);
        assert.equal(JSON.parse(f.items.get(LOGS_KEY)).records[0].outcome, 'pending');
        assert.equal(await (await response).text(), payload);
        const record = JSON.parse(f.items.get(LOGS_KEY)).records[0];
        assert.equal(record.outcome, 'completed');
        assert.equal(record.endMarker, 'done');
        assert.doesNotMatch(f.items.get(LOGS_KEY), /PRIVATE_PROMPT|PRIVATE_REPLY/);
        assert.equal(f.nodes.export.disabled, false);
        assert.match(f.nodes.status.textContent, /已收到协议结束标志/);
        f.click('export');
        const link = f.links[0];
        assert.equal(link.attached, true);
        assert.equal(link.clicked, true);
        assert.equal(link.removed, true);
        assert.match(link.download, /^connexhub-diagnostics-.*\.json$/);
        const exported = await (await fetch(link.href)).json();
        assert.equal(exported.records[0].id, record.id);
        f.toggle(false);
        assert.equal(f.host.fetch, f.original);
        assert.equal(f.items.get(ENABLED_KEY), 'false');
        assert.equal(JSON.parse(f.items.get(LOGS_KEY)).records.length, 1);
        f.click('clear');
        assert.equal(f.items.has(LOGS_KEY), false);
        assert.equal(f.nodes.export.disabled, true);
    } finally { f.panel.dispose(); }
});

test('saved consent/logs survive another panel load and unfinished snapshots are explicitly uncertain', async () => {
    const items = new Map([[ENABLED_KEY, 'true'], [LOGS_KEY, JSON.stringify({ schemaVersion: 1, records: [
        { id: 'old', startedAt: new Date().toISOString(), outcome: 'pending', inFlight: true },
    ] })]]);
    const f = setup({ items });
    try {
        assert.equal(f.nodes.enabled.checked, true);
        assert.notEqual(f.host.fetch, f.original);
        assert.match(f.nodes.status.textContent, /上次记录未完成/);
        assert.equal(JSON.parse(items.get(LOGS_KEY)).records[0].outcome, 'incomplete_snapshot');
        await (await f.host.fetch(requestUrl, options)).text();
        assert.equal(JSON.parse(items.get(LOGS_KEY)).records.length, 1);
        const saved = new Map(items);
        const reloaded = setup({ items: saved });
        assert.equal(reloaded.nodes.enabled.checked, true);
        assert.match(reloaded.nodes.status.textContent, /已收到协议结束标志/);
        reloaded.panel.dispose();
    } finally { f.panel.dispose(); }
});

test('storage/exports failing leave chat and in-memory records usable with a visible warning', async () => {
    const f = setup({ denied: true, exportFails: true });
    try {
        assert.match(f.nodes.status.textContent, /保存不可用/);
        f.toggle(true);
        assert.equal(await (await f.host.fetch(requestUrl, options)).text(), payload);
        assert.match(f.nodes.status.textContent, /保存不可用/);
        f.click('export');
        assert.match(f.nodes.status.textContent, /日志导出失败/);
        assert.equal(f.nodes.export.disabled, false);
        assert.equal(f.links[0].removed, true);
    } finally { f.panel.dispose(); }
});

test('pagehide/clear/disable never cancel an in-flight stream or resurrect cleared records', async () => {
    let resolve;
    const f = setup({ fetchImpl: () => new Promise(done => { resolve = done; }) });
    try {
        f.toggle(true);
        const pending = f.host.fetch(requestUrl, options);
        f.host.dispatchEvent(new Event('pagehide'));
        assert.equal(JSON.parse(f.items.get(LOGS_KEY)).records[0].inFlight, true);
        f.click('clear');
        f.toggle(false);
        resolve(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }));
        assert.equal(await (await pending).text(), payload);
        f.host.dispatchEvent(new Event('pagehide'));
        assert.equal(f.items.has(LOGS_KEY), false);
        assert.equal(f.host.fetch, f.original);
    } finally { f.panel.dispose(); }
});

test('unmount restores fetch and removes only diagnostics storage/events', async () => {
    const f = setup();
    f.items.set('native', 'untouched');
    f.toggle(true);
    await (await f.host.fetch(requestUrl, options)).text();
    f.panel.dispose();
    assert.equal(f.host.fetch, f.original);
    assert.equal(f.items.has(LOGS_KEY), false);
    assert.equal(f.items.get(ENABLED_KEY), 'false');
    assert.equal(f.items.get('native'), 'untouched');
    f.host.dispatchEvent(new Event('pagehide'));
    assert.equal(f.items.has(LOGS_KEY), false);
    const absent = setup({ missing: true });
    assert.equal(absent.panel, null);
    assert.equal(absent.host.fetch, absent.original);
});

test('real settings markup isolates diagnostics controls from editor clearing', () => {
    const html = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
    const tags = html.matchAll(/<\/?([\w-]+)\b[^>]*>/g);
    const stack = [];
    const ids = [];
    const voidTags = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);
    for (const [tag, name] of tags) {
        if (tag.startsWith('</')) { assert.equal(stack.pop()?.name, name); continue; }
        const id = /\bid="([^"]+)"/.exec(tag)?.[1];
        if (id?.startsWith('cxh_diagnostics')) {
            ids.push(id);
            assert.ok(!stack.some(entry => entry.id === 'cxh_editor'));
        }
        if (!tag.endsWith('/>') && !voidTags.has(name)) stack.push({ name, id });
    }
    assert.equal(stack.length, 0);
    for (const id of ['cxh_diagnostics', 'cxh_diagnostics_enabled', 'cxh_diagnostics_export', 'cxh_diagnostics_clear', 'cxh_diagnostics_status']) {
        assert.equal(ids.filter(value => value === id).length, 1);
    }
});