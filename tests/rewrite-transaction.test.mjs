import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const inplaceSource = readFileSync(new URL('../rewrite/inplace-rewrite.js', import.meta.url), 'utf8');
const revisionsSource = readFileSync(new URL('../rewrite/revisions.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../rewrite/ui.js', import.meta.url), 'utf8');
const controllerSource = readFileSync(new URL('../rewrite/controller.js', import.meta.url), 'utf8');

function load(source, context) {
    const executable = source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    vm.createContext(context);
    vm.runInContext(executable, context);
    return context;
}

function message(text = 'original') {
    return { name: 'Alice', mes: text, is_user: false, is_system: false,
        swipe_id: 0, swipes: [text], swipe_info: [{}], extra: {} };
}

function setupInplace() {
    const source = message();
    const events = [];
    const rendered = [];
    const ctx = {
        chat: [source], characterId: '0', groupId: null,
        getCurrentChatId: () => 'chat', extensionPrompts: {},
        mainApi: 'openai', setExtensionPrompt() {},
        substituteParams: text => text,
        saveChat: async () => {},
        addOneMessage: (mes, options) => {
            assert.equal(mes, ctx.chat[options.forceId]);
            assert.equal(typeof mes.name, 'string');
            rendered.push({ mes: structuredClone(mes), options });
        },
        eventSource: { emit: async (type, id) => events.push({ type, id }) },
        eventTypes: { MESSAGE_UPDATED: 'updated', MESSAGE_SWIPED: 'swiped' },
    };
    const context = load(inplaceSource, {
        core: { extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { ASSISTANT: 'assistant', USER: 'user' } },
        getContext: () => ctx,
        SWIPE_DIRECTION: { RIGHT: 1 }, SWIPE_SOURCE: { SWIPE_PICKER: 'picker' },
        getRegexedString: text => text, regex_placement: { AI_OUTPUT: 1, USER_INPUT: 2 },
        REVISION: 'auto_rewrite_revision', keyOf: ctx => `${ctx.groupId ?? ''}|${ctx.characterId ?? ''}|${ctx.getCurrentChatId() ?? ''}`,
        restoreMvu() {}, commitMvu() {}, mergeSwipeVariables() {}, finishMvu: async () => {}, mvuTransaction() {},
        structuredClone, console,
    });
    return { context, ctx, source, events, rendered };
}

function jobFor(f) {
    return { id: 'job', key: '|0|chat', index: 0, source: f.source,
        original: structuredClone(f.source), prefix: [], automatic: false,
        attempt: { swipeId: 0, text: 'original' }, timing: {}, injectionKeys: [] };
}

test('in-place commit preserves the original message identity and emits one final swipe', async () => {
    const f = setupInplace();
    const job = jobFor(f);
    f.source.extra.auto_rewrite_inplace = { id: job.id };
    const result = { ...message('rewritten'), swipe_id: 1, swipes: ['original', 'rewritten'] };
    await f.context.commitInplace(job, result);
    assert.equal(f.ctx.chat.length, 1);
    assert.equal(f.ctx.chat[0], f.source);
    assert.equal(f.source.mes, 'rewritten');
    assert.equal(f.source.name, 'Alice');
    assert.equal(f.source.extra.auto_rewrite_inplace, undefined);
    assert.deepEqual(f.events.map(e => e.type), ['updated', 'swiped']);
    assert.ok(f.events.every(e => e.id === 0));
    assert.equal(f.rendered.length, 1);
    assert.equal(f.rendered[0].options.type, 'swipe');
});

test('in-place failure restores the original object and removes transaction state', async () => {
    const f = setupInplace();
    const job = jobFor(f);
    f.source.extra.auto_rewrite_inplace = { id: job.id };
    f.source.mes = 'temporary';
    f.source.swipes.push('temporary');
    f.source.swipe_id = 1;
    assert.equal(await f.context.restoreInplace(job), true);
    assert.equal(f.ctx.chat.length, 1);
    assert.equal(f.ctx.chat[0], f.source);
    assert.equal(f.source.mes, 'original');
    assert.equal(f.source.swipe_id, 0);
    assert.equal(f.source.extra.auto_rewrite_inplace, undefined);
    assert.equal(f.rendered.length, 1);
    assert.deepEqual(f.events, [{ type: 'updated', id: 0 }]);
});

test('in-place preparation leaves native swipe creation to the native generator', async () => {
    const f = setupInplace();
    const job = jobFor(f);
    await f.context.prepareInplace(job, 'rewrite it');
    assert.equal(job.targetSwipe, 1);
    assert.equal(f.source.swipes.length, 1);
    assert.equal(f.source.swipe_id, 0);
    assert.equal(f.source.extra.auto_rewrite_inplace.id, job.id);

    let swipeOptions;
    f.ctx.swipe = { to: async (_event, _direction, options) => {
        swipeOptions = options;
        // Native swipe increments the ID before saveReply appends the slot.
        f.source.swipe_id++;
        f.source.swipes.length++;
        f.source.mes = 'rewritten';
        f.source.swipes[f.source.swipe_id] = f.source.mes;
        job.nativeStarted = true;
    } };
    await f.context.generateInplace(job);
    assert.equal(swipeOptions.forceSwipeId, undefined);
    assert.equal(swipeOptions.forceMesId, 0);
    assert.equal(f.source.swipe_id, 1);
    assert.equal(f.source.mes, 'rewritten');
    assert.equal(f.source.swipes.length, 2);

    // Native saveReply writes into the slot it just created.
    f.source.swipes.length++;
    assert.equal(f.source.swipe_id, f.source.swipes.length - 2,
        'a pre-created slot would make native endSwipe clamp back to the old swipe');
});

test('in-place no-op swipe restores the original DOM after native editing closes', async () => {
    const f = setupInplace();
    const job = jobFor(f);
    await f.context.prepareInplace(job, 'rewrite it');
    f.ctx.swipe = { to: async () => {
        // Native overswipe NONE/LOOP may return without GENERATION_STARTED.
        delete f.source.extra.auto_rewrite_inplace;
    } };
    await assert.rejects(f.context.generateInplace(job), /原楼重写未开始/);
    assert.equal(await f.context.restoreInplace(job), true);
    assert.equal(f.source.mes, 'original');
    assert.equal(f.rendered.length, 1);
    assert.deepEqual(f.events, [{ type: 'updated', id: 0 }]);
});

test('in-place preserves the stringified native error swallowed by the actual core warning', async () => {
    const f = setupInplace();
    const job = jobFor(f);
    await f.context.prepareInplace(job, 'rewrite it');
    f.ctx.swipe = { to: async () => {
        job.nativeStarted = true;
        // This is the exact call shape in the installed native endSwipe().
        console.warn("Swipe failed, Swiping back. TypeError: Cannot read properties of undefined (reading 'name')");
    } };
    await assert.rejects(f.context.generateInplace(job),
        /TypeError: Cannot read properties of undefined \(reading 'name'\)/);
});

test('in-place missing transaction after generation does not overwrite newer edits', async () => {
    const f = setupInplace();
    const job = jobFor(f);
    job.nativeStarted = true;
    f.source.mes = 'edited by another listener';
    assert.equal(await f.context.restoreInplace(job), false);
    assert.equal(f.source.mes, 'edited by another listener');
    assert.equal(f.rendered.length, 1);
    assert.deepEqual(f.events, [{ type: 'updated', id: 0 }]);
});

function setupRevisions() {
    const source = message();
    const feedback = { name: 'User', mes: 'rewrite it', is_user: true, is_system: false,
        extra: { auto_rewrite_temporary: { id: 'job' } } };
    const ctx = { chat: [source, feedback], characterId: '0', groupId: null, getCurrentChatId: () => 'chat' };
    const nodes = new Map();
    for (const [index, className] of [[0, 'mes'], [1, 'mes auto-rewrite-staging']]) {
        const classes = new Set(className.split(' '));
        nodes.set(index, {
            getAttribute: name => name === 'mesid' ? String(index) : null,
            classList: { contains: name => classes.has(name), toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
                add(name) { classes.add(name); }, remove(name) { classes.delete(name); } },
        });
    }
    const context = load(revisionsSource, {
        core: { redisplayChat: async () => {} }, getContext: () => ctx,
        SWIPE_DIRECTION: {}, SWIPE_SOURCE: {},
        restoreMvu() {}, commitMvu() {}, mergeSwipeVariables() {}, syncMvuChat() {}, mvuTransaction() {}, finishMvu: async () => {},
        structuredClone, console,
        document: { querySelector: () => null,
            querySelectorAll: selector => selector === '#chat > .mes' ? [...nodes.values()]
                : [...nodes.values()].filter(node => node.classList.contains(selector.slice(1))) },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    });
    return { context, ctx, source, feedback, nodes };
}

test('fallback staging hides the temporary feedback and never copies it into the source text', () => {
    const f = setupRevisions();
    const job = { id: 'job', key: '|0|chat', index: 0, source: f.source, feedback: f.feedback,
        original: structuredClone(f.source), prefix: [], attempt: { swipeId: 0, text: 'original' } };
    assert.equal(f.context.ownsTail(job), true);
    f.context.markStaging(job);
    assert.equal(f.nodes.get(1).classList.contains('auto-rewrite-staging'), true);
    assert.equal(f.source.mes, 'original');
    assert.equal(f.source.extra.auto_rewrite_temporary, undefined);
    f.context.showStaging();
    assert.equal(f.nodes.get(1).classList.contains('auto-rewrite-staging'), false);
});

test('rewrite controls mount only in native message buttons, never in message text', () => {
    let appendedTo = null;
    const buttons = { append: node => { appendedTo = node; node.parentElement = buttons; } };
    const host = { querySelector: selector => selector === ':scope > .mes_block .mes_buttons' ? buttons : null };
    const control = () => ({ addEventListener() {}, setAttribute() {}, querySelector: () => ({}) });
    const bar = { parentElement: null, querySelector: () => control() };
    const context = load(uiSource, {
        getSettings: () => ({ connectionId: '', model: '', auto: false }),
        getView: () => ({ reply: { index: 0 }, idle: true, busy: false, composerBusy: false }),
        getConnections: () => [], getActiveConnection: () => null,
        defaultFeedback: '', onSettings() {}, onRewrite() {}, onJump() {}, onVersions() {}, onMutation() {},
        document: {
            getElementById: () => null,
            querySelector: selector => selector === '#chat > .mes[mesid="0"]' ? host : null,
            createElement: () => bar,
        },
        MutationObserver: class { observe() {} disconnect() {} },
        requestAnimationFrame: callback => callback(), setInterval, clearInterval,
    });
    const ui = context.createRewriteUI({
        getSettings: () => ({ connectionId: '', model: '', auto: false }),
        getView: () => ({ reply: { index: 0 }, idle: true, busy: false, composerBusy: false }),
        getConnections: () => [], getActiveConnection: () => null,
        defaultFeedback: '', onSettings() {}, onRewrite() {}, onJump() {}, onVersions() {}, onMutation() {},
    });
    ui.refresh();
    assert.equal(appendedTo, bar);
    assert.equal(bar.parentElement, buttons);
});

test('auto rewrite checkbox persists the setting through the UI callback', () => {
    let enabled = false;
    let listener;
    const settings = { connectionId: '', model: '', auto: false };
    const auto = { dataset: {}, checked: true, addEventListener(type, callback) { if (type === 'change') listener = callback; } };
    const context = load(uiSource, {
        document: { getElementById: id => id === 'cxh_rewrite_auto' ? auto : null,
            querySelector: () => null, createElement: () => ({}) },
        MutationObserver: class { observe() {} disconnect() {} },
        requestAnimationFrame: callback => callback(), setInterval, clearInterval,
    });
    const ui = context.createRewriteUI({
        getSettings: () => settings,
        getView: () => ({ reply: null, idle: true, busy: false, composerBusy: false }),
        getConnections: () => [], getActiveConnection: () => null,
        defaultFeedback: '', onAuto: value => { enabled = value; settings.auto = value; }, onSettings() {},
        onRewrite() {}, onJump() {}, onVersions() {}, onMutation() {},
    });
    ui.install();
    assert.equal(typeof listener, 'function');
    auto.checked = true;
    listener();
    assert.equal(enabled, true);
});

test('rewrite blocker uses the native edit controls, not an unused swipe enum', () => {
    const start = controllerSource.indexOf('function rewriteBlocker(');
    const end = controllerSource.indexOf('\nfunction isIdle(', start);
    const fragment = start >= 0 && end > start ? controllerSource.slice(start, end) : '';
    const ctx = { streamingProcessor: null };
    // Native messageEdit sets an inline `display: inline-flex`; the idle state keeps
    // no inline style at all and relies on the stylesheet's `display: none`.
    let editButtons = [{ style: { display: 'inline-flex' } }];
    let editTextarea = false;
    const context = load(fragment, {
        core: { isChatSaving: false, is_send_press: false, swipeState: 'none' },
        SWIPE_STATE: { SWIPING: 'swiping', EDITING: 'editing' },
        getContext: () => ctx,
        document: { querySelector: selector => selector.includes(':is(') && editTextarea ? {} : null,
            querySelectorAll: () => editButtons },
        settings: () => ({ mvu: false }), mvuBusy: () => false,
    });
    assert.equal(context.rewriteBlocker(), '正在编辑消息');
    editButtons = [{ style: { display: 'none' } }, { style: {} }];
    assert.equal(context.rewriteBlocker(), '');
    editButtons = [{ style: {} }, { style: { display: '' } }];
    assert.equal(context.rewriteBlocker(), '');
    editButtons = [{ style: { display: 'none' } }];
    editTextarea = true;
    assert.equal(context.rewriteBlocker(), '正在编辑消息');
});
