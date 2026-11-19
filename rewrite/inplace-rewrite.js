import * as core from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { SWIPE_DIRECTION, SWIPE_SOURCE } from '../../../../constants.js';
import { getRegexedString, regex_placement } from '../../../regex/engine.js';
import { REVISION, keyOf } from './revisions.js';
import { restoreMvu, commitMvu, mergeSwipeVariables, finishMvu, mvuTransaction } from './mvu-compat.js';

const TRANSACTION = 'auto_rewrite_inplace';
const clone = value => structuredClone(value);
const info = message => ({ send_date: message.send_date, gen_started: message.gen_started,
    gen_finished: message.gen_finished, extra: clone(message.extra ?? {}) });
const usable = message => message && !message.is_user && !message.is_system
    && Boolean(message.mes?.trim()) && message.mes.trim() !== '...';
const fingerprint = text => {
    if (typeof text !== 'string') return null;
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return `${text.length}:${value >>> 0}`;
};

export const canRewriteInplace = () => getContext().mainApi === 'openai'
    && typeof getContext().setExtensionPrompt === 'function' && typeof getContext().swipe?.to === 'function';

export function ownsInplace(job) {
    const ctx = getContext();
    return keyOf(ctx) === job.key && ctx.chat[job.index] === job.source
        && job.source.extra?.[TRANSACTION]?.id === job.id
        && job.prefix.every((message, i) => ctx.chat[i] === message)
        && !ctx.chat.slice(job.index + 1).some(message => message.is_user);
}

export function clearInplacePrompts(job) {
    for (const key of job?.injectionKeys ?? []) delete getContext().extensionPrompts[key];
}

export function updateInplacePrompts(job, type = 'swipe') {
    if (!job?.inplace || !ownsInplace(job)) return;
    // In a tool continuation the original draft and feedback must precede the
    // tool exchange, rather than being repeated after its results.
    const tail = getContext().chat.slice(job.index);
    const depth = type === 'swipe' ? 0 : tail.filter(m => !m.is_system || Array.isArray(m.extra?.tool_invocations)).length;
    const draft = getRegexedString(job.original.mes, regex_placement.AI_OUTPUT, { isPrompt: true, depth: depth + 1 });
    const feedback = getRegexedString(job.inplaceFeedback, regex_placement.USER_INPUT, { isPrompt: true, depth });
    // Native CC in-chat injection visits newest first (user, assistant), then
    // inserts at the start of chatHistory: assistant draft -> user feedback.
    getContext().setExtensionPrompt(job.injectionKeys[0], draft, core.extension_prompt_types.IN_CHAT,
        depth, true, core.extension_prompt_roles.ASSISTANT);
    getContext().setExtensionPrompt(job.injectionKeys[1], feedback, core.extension_prompt_types.IN_CHAT,
        depth, true, core.extension_prompt_roles.USER);
}

export async function prepareInplace(job, feedback) {
    const ctx = getContext();
    job.inplaceFeedback = ctx.substituteParams(getRegexedString(feedback, regex_placement.USER_INPUT));
    if (!job.inplaceFeedback.trim()) throw new Error('修改意见被用户输入正则清空');
    job.inplace = true;
    job.injectionKeys = [`auto_rewrite_${job.id}_draft`, `auto_rewrite_${job.id}_feedback`];
    const source = job.source;
    source.swipes ??= [source.mes];
    if (!source.swipes.length) source.swipes.push(source.mes);
    source.swipe_id ??= 0;
    source.swipes[job.attempt.swipeId] = job.attempt.text;
    source.swipe_info ??= [];
    source.swipe_info[job.attempt.swipeId] = info(job.original);
    job.targetSwipe = source.swipes.length;
    source.extra ??= {};
    source.extra[TRANSACTION] = { id: job.id, index: job.index, original: clone(job.original) };
    // Preserve the old swipe's MVU snapshot; native receive listeners will write
    // the rewritten state into the new slot using the prepared chat baseline.
    if (job.mvu && job.original.variables?.[job.attempt.swipeId]) {
        source.variables[job.attempt.swipeId] = clone(job.original.variables[job.attempt.swipeId]);
    }
    updateInplacePrompts(job);
    await ctx.saveChat();
}

export async function generateInplace(job) {
    job.awaitingNativeSwipe = true;
    // Use the arrow handler itself: it owns the new slot, busy state, streaming,
    // stop button and ordinary receive/swipe events on the existing message ID.
    await getContext().swipe.to(null, SWIPE_DIRECTION.RIGHT,
        { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: job.index,
            forceSwipeId: job.targetSwipe, forceDuration: 0 });
    job.awaitingNativeSwipe = false;
    if (!job.nativeStarted || !ownsInplace(job)) throw new Error('原楼重写未开始或聊天已变化；请确认末页右箭头设为生成新版本');
    const result = getInplaceReply(job);
    if (result) return result;
    throw new Error('未收到可用的同楼重写正文');
}

export function getInplaceReply(job) {
    if (!job.nativeStarted || !ownsInplace(job)) return null;
    const ctx = getContext();
    for (let i = ctx.chat.length - 1; i > job.index; i--) {
        if (usable(ctx.chat[i])) return ctx.chat[i];
    }
    // The old message text can remain visible before the new slot receives data.
    // A populated target slot distinguishes a rewrite from the untouched draft.
    if (usable(job.source) && job.source.swipe_id === job.targetSwipe
        && typeof job.source.swipes?.[job.targetSwipe] === 'string'
        && job.source.swipes[job.targetSwipe].trim() && job.source.swipes[job.targetSwipe].trim() !== '...') return job.source;
    return null;
}

export function rememberStoppedInplace(job) {
    if (!ownsInplace(job) || !usable(job.stoppedDraft)) return;
    const draft = clone(job.stoppedDraft);
    delete draft.extra?.[TRANSACTION];
    job.source.extra[TRANSACTION].stopped = { draft, targetSwipe: job.targetSwipe, resultIndex: job.stoppedIndex,
        timing: clone(job.timing), automatic: job.automatic };
}

export async function commitInplace(job, result) {
    if (!ownsInplace(job)) throw new Error('聊天已变化，未覆盖新的聊天内容');
    const ctx = getContext();
    const original = clone(job.original);
    original.swipes ??= [original.mes];
    if (!original.swipes.length) original.swipes.push(original.mes);
    original.swipes[job.attempt.swipeId] = job.attempt.text;
    original.swipe_info = original.swipes.map((_, i) => clone(original.swipe_info?.[i] ?? {}));
    original.swipe_info[job.attempt.swipeId] = info(job.original);
    const final = { ...original, ...clone(result), name: original.name, is_user: false, is_system: false };
    final.extra = clone(result.extra ?? {});
    delete final.extra[TRANSACTION];
    delete final.extra.auto_rewrite_mvu;
    const parent = original.extra?.[REVISION];
    let originalSwipe = parent?.originalHash ? original.swipes.findIndex(text => fingerprint(text) === parent.originalHash)
        : Number.isInteger(parent?.originalSwipe) ? parent.originalSwipe : job.attempt.swipeId;
    if (originalSwipe < 0 || originalSwipe >= original.swipes.length) originalSwipe = job.attempt.swipeId;
    final.extra[REVISION] = { id: job.id, originalSwipe, originalHash: fingerprint(original.swipes[originalSwipe]),
        sourceSwipe: job.attempt.swipeId, rewrittenSwipe: original.swipes.length,
        automatic: job.automatic, timing: { ...job.timing }, inplace: true,
        stopped: Boolean(job.stopRequested), mvuPending: Boolean(job.mvuPending) };
    // Preserve any native tool-continuation records as an archive on this swipe.
    // Never copy tool invocations into prose or silently discard plugin records.
    const intermediates = ctx.chat.slice(job.index + 1).filter((m, offset) => m !== result
        && (!job.stopRequested || job.index + 1 + offset !== job.stoppedIndex));
    if (intermediates.length) final.extra[REVISION].intermediates = clone(intermediates);
    final.swipes = [...original.swipes, final.mes];
    final.swipe_id = original.swipes.length;
    final.swipe_info = [...original.swipe_info, info(final)];
    mergeSwipeVariables(original, result, final);
    commitMvu(job, final);
    // Keep the original message object and ID. Subscribers see an update/swipe,
    // not a newly received ordinary chat turn followed by a deletion.
    for (const key of Object.keys(job.source)) if (!Object.hasOwn(final, key)) delete job.source[key];
    Object.assign(job.source, final);
    if (ctx.chat.length > job.index + 1) ctx.chat.splice(job.index + 1);
    job.settled = true;
    clearInplacePrompts(job);
    ctx.addOneMessage(job.source, { type: 'swipe', forceId: job.index, scroll: false });
    await ctx.saveChat();
    await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_UPDATED, job.index);
    if (keyOf(getContext()) !== job.key || ctx.chat[job.index] !== job.source) return;
    await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_SWIPED, job.index);
    if (keyOf(getContext()) !== job.key || ctx.chat[job.index] !== job.source) return;
    job.source.swipes[job.source.swipe_id] = job.source.mes;
    job.source.swipe_info[job.source.swipe_id] = info(job.source);
    await ctx.saveChat();
}

export async function restoreInplace(job) {
    clearInplacePrompts(job);
    const ctx = getContext();
    if (keyOf(ctx) !== job.key || ctx.chat[job.index] !== job.source) return false;
    if (!job.source.extra?.[TRANSACTION] && job.mvu) {
        restoreMvu(job);
        await ctx.saveChat();
        return true;
    }
    if (job.source.extra?.[TRANSACTION]?.id !== job.id) return false;
    const owned = ownsInplace(job);
    restoreMvu(job, { restoreChat: owned });
    const original = clone(job.original);
    for (const key of Object.keys(job.source)) if (!Object.hasOwn(original, key)) delete job.source[key];
    Object.assign(job.source, original);
    if (owned && !job.recovering) ctx.chat.splice(job.index + 1);
    job.settled = true;
    ctx.addOneMessage(job.source, { type: 'swipe', forceId: job.index, scroll: false });
    await ctx.saveChat();
    return owned;
}

export async function recoverInplace() {
    const ctx = getContext();
    const index = ctx.chat.findIndex(m => m.extra?.[TRANSACTION]?.original);
    if (index < 0) return false;
    const source = ctx.chat[index], record = source.extra[TRANSACTION];
    if (usable(record.stopped?.draft)) {
        const job = { id: record.id, index, source, original: record.original,
            key: keyOf(ctx), prefix: ctx.chat.slice(0, index),
            attempt: { swipeId: record.original.swipe_id ?? 0, text: record.original.mes },
            targetSwipe: record.stopped.targetSwipe, stoppedIndex: record.stopped.resultIndex, timing: record.stopped.timing,
            automatic: record.stopped.automatic, stopRequested: true, mvu: mvuTransaction(source) };
        const result = clone(record.stopped.draft);
        await finishMvu(job, result, () => ownsInplace(job));
        await commitInplace(job, result);
        return 'stopped';
    }
    return restoreInplace({ id: record.id, index, source, original: record.original,
        key: keyOf(ctx), prefix: ctx.chat.slice(0, index), recovering: true });
}
