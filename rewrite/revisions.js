import * as core from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { SWIPE_DIRECTION, SWIPE_SOURCE } from '../../../../constants.js';
import { restoreMvu, commitMvu, mergeSwipeVariables, syncMvuChat, mvuTransaction, finishMvu } from './mvu-compat.js';

export const REVISION = 'auto_rewrite_revision';
export const TEMP = 'auto_rewrite_temporary';
const RECEIPT = 'st.auto-rewrite.pending:';
export const keyOf = ctx => `${ctx.groupId ?? ''}|${ctx.characterId ?? ''}|${ctx.getCurrentChatId() ?? ''}`;

function fingerprint(text) {
    // Native swipe generation can temporarily expose an unfilled array slot.
    if (typeof text !== 'string') return null;
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return `${text.length}:${value >>> 0}`;
}

export function remember(job) {
    try { sessionStorage.setItem(RECEIPT + job.key, JSON.stringify({ id: job.id, index: job.index,
        sourceSwipe: job.attempt.swipeId, sourceHash: fingerprint(job.attempt.text) })); } catch { /* Storage is optional. */ }
}

export function forget(job) {
    try {
        const saved = JSON.parse(sessionStorage.getItem(RECEIPT + job.key) || 'null');
        if (saved?.id === job.id) sessionStorage.removeItem(RECEIPT + job.key);
    } catch { /* Storage is optional. */ }
}

export function ownsTail(job, ctx = getContext()) {
    return keyOf(ctx) === job.key && ctx.chat[job.index] === job.source
        && job.source.mes === job.attempt.text && (job.source.swipe_id ?? 0) === job.attempt.swipeId
        && job.prefix.every((message, i) => ctx.chat[i] === message)
        && ctx.chat[job.index + 1] === job.feedback && job.feedback?.extra?.[TEMP]?.id === job.id
        && ctx.chat.slice(job.index + 2).every(message => !message.is_user);
}

export function rememberStoppedFallback(job) {
    if (!ownsTail(job) || !job.stoppedDraft?.mes?.trim()) return;
    job.feedback.extra[TEMP].stopped = { draft: structuredClone(job.stoppedDraft),
        timing: structuredClone(job.timing), automatic: job.automatic };
}

export function liveReply(job) {
    if (!job || job.cancelled || !ownsTail(job)) return null;
    const ctx = getContext();
    for (let index = ctx.chat.length - 1; index > job.index + 1; index--) {
        const message = ctx.chat[index];
        if (!message.is_user && !message.is_system && document.querySelector(`#chat > .mes[mesid="${index}"]`)) {
            return { key: job.key, index, message, text: message.mes, swipeId: message.swipe_id ?? 0, preview: true };
        }
    }
    return null;
}

function revealOriginal(source) {
    source?.classList.remove('auto-rewrite-preview-covered');
    source?.querySelectorAll('.auto-rewrite-preview-old').forEach(node => node.classList.remove('auto-rewrite-preview-old'));
    source?.querySelectorAll('.auto-rewrite-preview-waiting').forEach(node => node.remove());
}

export function markStaging(job) {
    if (!job || !ownsTail(job)) return;
    const source = document.querySelector(`#chat > .mes[mesid="${job.index}"]`);
    const preview = liveReply(job);
    document.querySelectorAll('#chat > .mes').forEach(node => {
        const index = Number(node.getAttribute('mesid'));
        if (index > job.index) node.classList.toggle('auto-rewrite-staging', index !== preview?.index);
    });
    if (job.cancelled) { revealOriginal(source); return; }
    if (preview) {
        // Keep the actual native streaming message visible. No text copies,
        // alternate formatter, or changes to the request/history are involved.
        source?.classList.add('auto-rewrite-preview-covered');
        return;
    }
    // Before core creates its streaming message, show a blank rewrite page
    // instead of continuing to present the old draft as the current output.
    source?.classList.remove('auto-rewrite-preview-covered');
    const block = source?.querySelector('.mes_block');
    if (!block) return;
    for (const node of block.children) {
        if (!node.matches('.ch_name, .auto-rewrite-actions, .auto-rewrite-footer, .auto-rewrite-preview-waiting')) node.classList.add('auto-rewrite-preview-old');
    }
    if (!block.querySelector('.auto-rewrite-preview-waiting')) {
        const waiting = document.createElement('div');
        waiting.className = 'auto-rewrite-preview-waiting';
        waiting.setAttribute('role', 'status');
        waiting.innerHTML = '<span class="auto-rewrite-preview-label">重写中 · 新版本</span><p>正在等待上游返回内容…</p>';
        const footer = block.querySelector(':scope > .auto-rewrite-footer, :scope > .auto-rewrite-actions');
        if (footer) footer.before(waiting); else block.append(waiting);
    }
}

export function showStaging() {
    document.querySelectorAll('.auto-rewrite-staging').forEach(node => node.classList.remove('auto-rewrite-staging'));
    document.querySelectorAll('.auto-rewrite-preview-covered').forEach(node => node.classList.remove('auto-rewrite-preview-covered'));
    document.querySelectorAll('.auto-rewrite-preview-old').forEach(node => node.classList.remove('auto-rewrite-preview-old'));
    document.querySelectorAll('.auto-rewrite-preview-waiting').forEach(node => node.remove());
}

function captureAnchor(index, preserve = false) {
    const viewport = document.getElementById('chat');
    if (!viewport) return null;
    const top = viewport.getBoundingClientRect().top;
    const anchor = [...viewport.querySelectorAll(':scope > .mes')]
        .find(node => !node.classList.contains('auto-rewrite-staging')
            && !node.classList.contains('auto-rewrite-preview-covered')
            && node.getBoundingClientRect().bottom > top);
    const anchorId = Number(anchor?.getAttribute('mesid'));
    const readingAbove = Number.isInteger(anchorId) && anchorId < index;
    const body = anchor?.querySelector('.mes_text') || anchor;
    const bodyOffset = body ? body.getBoundingClientRect().top - top : 12;
    return {
        viewport,
        targetId: readingAbove ? anchorId : index,
        useBody: !readingAbove,
        offset: readingAbove ? anchor.getBoundingClientRect().top - top : preserve && anchor ? Math.min(bodyOffset, 12) : 12,
    };
}

function applyAnchor(pin) {
    if (!pin?.viewport?.isConnected) return;
    const target = pin.viewport.querySelector(`.mes[mesid="${pin.targetId}"]`);
    if (!target) return;
    const el = pin.useBody ? target.querySelector('.mes_text') || target : target;
    pin.viewport.scrollTop += (el.getBoundingClientRect().top - pin.viewport.getBoundingClientRect().top) - pin.offset;
}

async function redraw(index, key, { preserve = false } = {}) {
    if (keyOf(getContext()) !== key) return null;
    const pin = captureAnchor(index, preserve);
    await core.redisplayChat({ startIndex: index, fade: false });
    if (keyOf(getContext()) !== key) return null;
    applyAnchor(pin);
    return pin;
}

function info(message) {
    return { send_date: message.send_date, gen_started: message.gen_started, gen_finished: message.gen_finished,
        extra: structuredClone(message.extra ?? {}) };
}

export async function collapse(job, result) {
    const ctx = getContext();
    if (!ownsTail(job, ctx)) throw new Error('聊天或原稿已变化，未覆盖新的聊天内容');
    const original = structuredClone(job.original);
    const sourceSwipe = job.attempt.swipeId;
    if (!Array.isArray(original.swipes) || !original.swipes.length) original.swipes = [original.mes];
    original.swipes[sourceSwipe] = job.attempt.text;
    original.swipe_info = original.swipes.map((_, i) => structuredClone(original.swipe_info?.[i] ?? {}));
    original.swipe_info[sourceSwipe] = info(original);
    const final = { ...original, ...structuredClone(result), name: original.name, is_user: false, is_system: false };
    final.extra = structuredClone(result.extra ?? {});
    delete final.extra[TEMP];
    const parent = original.extra?.[REVISION];
    const inherited = parent?.originalHash ? original.swipes.findIndex(text => fingerprint(text) === parent.originalHash) : parent?.originalSwipe;
    const originalSwipe = Number.isInteger(inherited) && inherited >= 0 && inherited < original.swipes.length ? inherited : sourceSwipe;
    const rewrittenSwipe = original.swipes.length;
    final.extra[REVISION] = { id: job.id, originalSwipe, originalHash: fingerprint(original.swipes[originalSwipe]), sourceSwipe, rewrittenSwipe,
        automatic: job.automatic, timing: { ...job.timing },
        stopped: Boolean(job.stopRequested), mvuPending: Boolean(job.mvuPending) };
    final.swipes = [...original.swipes, final.mes];
    final.swipe_id = rewrittenSwipe;
    final.swipe_info = [...original.swipe_info, info(final)];
    mergeSwipeVariables(original, result, final);
    ctx.chat.splice(job.index, ctx.chat.length - job.index, final);
    commitMvu(job, final);
    job.settled = true;
    await ctx.saveChat();
    forget(job);
    const pin = await redraw(job.index, job.key, { preserve: true });
    if (keyOf(getContext()) !== job.key) return;
    await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_DELETED, ctx.chat.length);
    if (keyOf(getContext()) !== job.key) return;
    await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_UPDATED, job.index);
    if (keyOf(getContext()) !== job.key) return;
    await ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, job.index, 'swipe');
    requestAnimationFrame(() => { if (keyOf(getContext()) === job.key) applyAnchor(pin); });
    if (keyOf(getContext()) !== job.key || ctx.chat[job.index] !== final) return;
    final.swipes[final.swipe_id] = final.mes;
    final.swipe_info[final.swipe_id] = info(final);
    await ctx.saveChat();
}

export async function restore(job) {
    const ctx = getContext();
    if (!job.feedback) {
        if (keyOf(ctx) === job.key && ctx.chat[job.index] === job.source && mvuTransaction(job.source)) {
            restoreMvu(job);
            await ctx.saveChat();
        }
        forget(job); return true;
    }
    if (!ownsTail(job, ctx)) {
        // Another turn may have taken over. Undo our source snapshot without
        // rolling back newer messages or their current chat-variable mirror.
        if (keyOf(ctx) === job.key && ctx.chat[job.index] === job.source && mvuTransaction(job.source)) {
            restoreMvu(job, { restoreChat: false });
            await ctx.saveChat();
        }
        return false;
    }
    restoreMvu(job);
    ctx.chat.splice(job.index + 1);
    job.settled = true;
    await ctx.saveChat();
    forget(job);
    const pin = await redraw(job.index, job.key, { preserve: true });
    if (keyOf(getContext()) !== job.key) return true;
    await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_DELETED, ctx.chat.length);
    requestAnimationFrame(() => { if (keyOf(getContext()) === job.key) applyAnchor(pin); });
    if (keyOf(getContext()) === job.key) await ctx.saveChat();
    return true;
}

export async function recover() {
    const ctx = getContext();
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(RECEIPT + keyOf(ctx)) || 'null'); } catch { /* Use the persisted MVU transaction below. */ }
    if (!saved) {
        const index = ctx.chat.findIndex((message, i) => {
            const transaction = mvuTransaction(message);
            return transaction && ctx.chat[i + 1]?.extra?.[TEMP]?.id === transaction.id;
        });
        if (index >= 0) {
            const transaction = mvuTransaction(ctx.chat[index]);
            saved = { id: transaction.id, index, sourceSwipe: transaction.swipe, sourceHash: fingerprint(ctx.chat[index].mes ?? '') };
        }
    }
    if (!saved || !Number.isInteger(saved.index)) return false;
    const source = ctx.chat[saved.index];
    const feedback = ctx.chat[saved.index + 1];
    if (!source || source.is_user || source.is_system || fingerprint(source.mes ?? '') !== saved.sourceHash || feedback?.extra?.[TEMP]?.id !== saved.id) return false;
    const stopped = feedback.extra[TEMP].stopped;
    if (stopped?.draft?.mes?.trim() && stopped.draft.mes.trim() !== '...') {
        const job = { ...saved, key: keyOf(ctx), source, feedback,
            prefix: ctx.chat.slice(0, saved.index), mvu: mvuTransaction(source),
            attempt: { text: source.mes, swipeId: saved.sourceSwipe },
            stopRequested: true, timing: stopped.timing, automatic: stopped.automatic };
        restoreMvu(job);
        job.original = structuredClone(source);
        const result = structuredClone(stopped.draft);
        await finishMvu(job, result, () => ownsTail(job));
        await collapse(job, result);
        return 'stopped';
    }
    return restore({ ...saved, key: keyOf(ctx), source, feedback, prefix: ctx.chat.slice(0, saved.index),
        attempt: { text: source.mes, swipeId: saved.sourceSwipe } });
}

export function versionLink(reply) {
    const message = reply?.message;
    if (!message || !Array.isArray(message.swipes)) return null;
    const current = message.swipe_id ?? 0;
    if (!Number.isInteger(current) || current < 0 || current >= message.swipes.length
        || typeof message.swipes[current] !== 'string') return null;
    const record = message.extra?.[REVISION];
    const originalSwipe = record?.originalHash ? message.swipes.findIndex(text => fingerprint(text) === record.originalHash) : record?.originalSwipe;
    if (Number.isInteger(originalSwipe) && originalSwipe >= 0
        && originalSwipe < message.swipes.length && originalSwipe !== current) {
        return { target: originalSwipe, label: '查看原稿', original: false };
    }
    for (let i = message.swipes.length - 1; i >= 0; i--) {
        const item = message.swipe_info?.[i]?.extra?.[REVISION];
        const sameOriginal = item?.originalHash ? item.originalHash === fingerprint(message.swipes[current]) : item?.originalSwipe === current;
        if (i !== current && item && sameOriginal) return { target: i, label: '返回重写版', original: true };
    }
    return null;
}

export async function jumpVersion(reply, target) {
    const ctx = getContext();
    const message = ctx.chat[reply.index];
    if (keyOf(ctx) !== reply.key || message !== reply.message || (message.swipe_id ?? 0) !== reply.swipeId
        || !Number.isInteger(target) || target < 0 || target >= (message.swipes?.length ?? 0)) return;
    await ctx.swipe.to(null, target < reply.swipeId ? SWIPE_DIRECTION.LEFT : SWIPE_DIRECTION.RIGHT,
        { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: reply.index, forceSwipeId: target, forceDuration: 0 });
    if (keyOf(getContext()) === reply.key) {
        syncMvuChat(message);
        await redraw(reply.index, reply.key);
        await ctx.saveChat();
    }
}
