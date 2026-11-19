import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Regression: rewrite() used to read `route.conn.name`, but beginRoute() only
// guarantees { id, label, release }. The TypeError was thrown while recording a
// diagnostic, which aborted the whole rewrite *before* the request was sent, so
// users saw "重写未完成，原稿已保留：Cannot read properties of undefined (reading 'name')".
// These tests execute the real controller module instead of mirroring its logic.

const controllerSource = readFileSync(new URL('../rewrite/controller.js', import.meta.url), 'utf8');

function stripModuleSyntax(source) {
    const lines = source.split(/\r?\n/);
    const out = [];
    let inImport = false;
    for (const line of lines) {
        if (!inImport && /^import\b/.test(line)) {
            if (/;\s*$/.test(line)) continue;
            inImport = true;
            continue;
        }
        if (inImport) {
            if (/;\s*$/.test(line)) inImport = false;
            continue;
        }
        out.push(line.replace(/^export\s+/, ''));
    }
    return out.join('\n');
}

function message(text = 'original') {
    return { name: 'Alice', mes: text, is_user: false, is_system: false,
        swipe_id: 0, swipes: [text], swipe_info: [{}], extra: {} };
}

const EVENT_TYPES = {
    APP_READY: 'app_ready', SETTINGS_LOADED: 'settings_loaded',
    CONNECTION_PROFILE_CREATED: 'connection_profile_created',
    CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
    CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
    CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
    CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
    SETTINGS_UPDATED: 'settings_updated', OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
    PRESET_CHANGED: 'preset_changed', CHARACTER_DELETED: 'character_deleted',
    GENERATION_STARTED: 'generation_started', MESSAGE_RECEIVED: 'message_received',
    GENERATION_ENDED: 'generation_ended', MESSAGE_EDITED: 'message_edited',
    MESSAGE_SWIPED: 'message_swiped', GENERATION_STOPPED: 'generation_stopped',
    MESSAGE_SENT: 'message_sent', USER_MESSAGE_RENDERED: 'user_message_rendered',
};

function createHarness({ route = { id: 'r1', label: 'Main / m', release() {} }, failWith } = {}) {
    const source = message();
    const records = [];
    const handlers = new Map();
    const ctx = {
        chat: [source], characterId: '0', groupId: null,
        getCurrentChatId: () => 'chat', extensionPrompts: {}, chatMetadata: {},
        name1: 'User', mainApi: 'openai', powerUserSettings: {},
        substituteParams: text => text, saveChat: async () => {},
        getThumbnailUrl: () => 'thumb', addOneMessage() {},
        eventTypes: EVENT_TYPES,
        eventSource: {
            on: (type, handler) => { handlers.set(type, handler); },
            emit: async () => {},
        },
        generate: async () => { throw failWith; },
    };
    const settings = { auto: false, connectionId: '', model: '', mvu: false, baseFeedback: '', feedback: '' };
    const deps = {
        getSettings: () => settings,
        getConnections: () => [{ id: 'main', name: '主连接', endpoint: 'http://x', model: 'm', format: 'openai' }],
        getMainConnectionId: () => 'main',
        beginRoute: () => route,
        recordDiagnostic: record => records.push(record),
        save() {},
    };
    const context = {
        core: { isChatSaving: false, is_send_press: false, swipeState: 'idle', user_avatar: null },
        getContext: () => ctx,
        SWIPE_STATE: { SWIPING: 'swiping', EDITING: 'editing' },
        hasPendingFileAttachment: () => false,
        getRegexedString: text => text,
        regex_placement: { USER_INPUT: 1, AI_OUTPUT: 2 },
        createRewriteUI: () => ({ install() {}, sync() {}, refresh() {} }),
        resolveManualRewriteConnection: (connections, mainId, value) => {
            const id = value?.connectionId || mainId;
            const conn = connections.find(item => item.id === id);
            return { conn, model: String(value?.model || '').trim() || String(conn?.model || '').trim() };
        },
        createBackgroundScheduler: () => ({ request() {}, cancel() {}, retry() {} }),
        disposeBackgroundDelays() {},
        mvuBusy: () => false, mvuFeedback: '', prepareMvu() {}, resetMvuFeedback() {},
        finishMvu: async () => {}, syncMvuChat: () => {}, waitMvuWindow: async () => {},
        canRewriteInplace: () => false, prepareInplace: async () => {}, generateInplace: async () => null,
        commitInplace: async () => {}, restoreInplace: async () => true, recoverInplace: async () => {},
        ownsInplace: () => false, updateInplacePrompts() {}, clearInplacePrompts() {},
        getInplaceReply: () => null, rememberStoppedInplace() {},
        REVISION: 'auto_rewrite_revision', TEMP: 'auto_rewrite_temporary',
        remember() {}, collapse: async () => {}, restore: async () => true, recover: async () => {},
        markStaging() {}, liveReply: () => null, showStaging() {}, versionLink: () => null,
        jumpVersion: async () => {}, ownsTail: () => true, rememberStoppedFallback() {},
        structuredClone, console,
        // controller.enable() wires a couple of jQuery delegated listeners.
        $: () => ({ on() {}, off() {} }),
        window: { addEventListener() {}, removeEventListener() {} },
        document: {
            querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
            createElement: () => ({ dataset: {}, style: {}, append() {}, addEventListener() {} }),
            head: { append() {} }, addEventListener() {}, removeEventListener() {},
        },
    };
    vm.createContext(context);
    vm.runInContext(stripModuleSyntax(controllerSource), context);
    context.createRewriteController(deps);
    context.enable();
    return { context, ctx, source, records, settings, handlers };
}

function attemptFor(source) {
    return { key: '|0|chat', index: 0, message: source, text: source.mes, swipeId: 0 };
}

test('missing conn on the route object must not abort the rewrite before the request', async () => {
    const sentinel = new Error('SENTINEL_REQUEST_REACHED');
    const f = createHarness({ failWith: sentinel });

    await f.context.rewrite(attemptFor(f.source), false);

    const pending = f.records.find(record => record.outcome === 'pending');
    assert.ok(pending, 'the pending diagnostic must be recorded before the request');
    assert.equal(pending.connectionName, '(未命名)');
    assert.equal(pending.rewriteId, 'r1');

    const failed = f.records.at(-1);
    assert.equal(failed.outcome, 'failed');
    // The failure must come from the generation step, proving the request phase was reached.
    assert.match(failed.error, /SENTINEL_REQUEST_REACHED/);
    assert.doesNotMatch(failed.error, /Cannot read properties of undefined/);
});

test('a route that exposes conn/model records the real connection name', async () => {
    const sentinel = new Error('SENTINEL_REQUEST_REACHED');
    const f = createHarness({
        route: { id: 'r2', label: '第二连接 / m2', conn: { name: '第二连接' }, model: 'm2', release() {} },
        failWith: sentinel,
    });

    await f.context.rewrite(attemptFor(f.source), false);

    const pending = f.records.find(record => record.outcome === 'pending');
    assert.equal(pending.connectionName, '第二连接');
    assert.equal(pending.model, 'm2');
});

test('beginRewriteRoute in index.js exposes conn and model to its callers', () => {
    const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const start = indexSource.indexOf('function beginRewriteRoute(');
    assert.ok(start > -1, 'beginRewriteRoute must exist');
    const end = indexSource.indexOf('function rewriteRouteContext(', start);
    const body = indexSource.slice(start, end);
    assert.match(body, /conn:\s*route\.conn/);
    assert.match(body, /model:\s*route\.model/);
});
