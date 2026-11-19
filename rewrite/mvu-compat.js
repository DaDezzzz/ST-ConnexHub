import { getContext } from '../../../../extensions.js';
import { backgroundDelay } from './background-scheduler.js';

// MVU stores a complete state in message.variables[swipe_id], outside swipe_info.
// Keep only its own fields in the transaction so other scripts retain their data.
const FIELDS = ['initialized_lorebooks', 'stat_data', 'schema', 'display_data', 'delta_data'];
const TRANSACTION = 'auto_rewrite_mvu';
export const mvuFeedback = '\n\n【MVU 重写约定】本次是替换上一版正文，不是推进下一轮剧情。上一版的变量更新作废；当前提供的变量是本轮开始前的状态。如需输出变量更新，请只计算重写版相对此状态的变化，不要累加上一版的变化。';

export function mvuBusy() {
    return Boolean(globalThis.Mvu?.isDuringExtraAnalysis?.());
}

export async function waitMvuWindow(readyAt, isCurrent) {
    // MVU drops receive events inside its 3-second leading-only throttle. Wait
    // before starting the second request so even a cached/short reply is parsed.
    while (Date.now() < readyAt || mvuBusy()) {
        if (!isCurrent()) throw new Error('重写已取消或聊天已变化');
        await backgroundDelay(100);
    }
    if (!isCurrent()) throw new Error('重写已取消或聊天已变化');
}

const activeData = message => message?.variables?.[message.swipe_id ?? 0];
const isMvuData = data => data?.stat_data != null && data?.schema != null;
export const mvuTransaction = message => message?.extra?.[TRANSACTION];

function pick(data) {
    const result = {};
    for (const field of FIELDS) {
        if (data && Object.hasOwn(data, field)) result[field] = structuredClone(data[field]);
    }
    return result;
}

function replaceFields(target, data) {
    for (const field of FIELDS) {
        if (Object.hasOwn(data, field)) target[field] = structuredClone(data[field]);
        else delete target[field];
    }
}

function slot(message, swipe = message.swipe_id ?? 0) {
    message.variables ??= [];
    return message.variables[swipe] ??= {};
}

export function prepareMvu(job) {
    const ctx = getContext();
    const current = activeData(job.source);
    // No MVU dependency is introduced for ordinary chats or other variable systems.
    if (!globalThis.Mvu && !isMvuData(current)) return;
    let baseline;
    for (let i = job.index - 1; i >= 0; i--) {
        const data = activeData(ctx.chat[i]);
        if (isMvuData(data)) { baseline = pick(data); break; }
    }
    if (!baseline && !isMvuData(current)) return;
    if (!baseline) throw new Error('找不到本轮开始前的 MVU 变量快照，已保留原稿；请先用 MVU 恢复历史楼层变量');
    if (!isMvuData(current)) throw new Error('本轮 MVU 变量尚未写入，请等变量更新完成后再重写');
    const transaction = {
        id: job.id, swipe: job.attempt.swipeId, original: pick(current), baseline,
        chat: pick(ctx.chatMetadata?.variables),
        mirrorChat: isMvuData(ctx.chatMetadata?.variables),
    };
    job.mvu = transaction;
    // Persist the undo information on the source alongside the temporary feedback.
    // It survives reloads, unlike the in-memory job or sessionStorage receipt alone.
    job.source.extra ??= {};
    job.source.extra[TRANSACTION] = transaction;
    replaceFields(slot(job.source), baseline);
    if (transaction.mirrorChat) replaceFields(ctx.chatMetadata.variables, baseline);
}

export function resetMvuFeedback(job) {
    if (!job.mvu) return;
    // MESSAGE_SENT runs MVU and other listeners. Discard any variable commands in
    // the temporary feedback and give prompt macros/extra-model parsing the baseline.
    replaceFields(slot(job.feedback), job.mvu.baseline);
    if (job.mvu.mirrorChat) replaceFields(getContext().chatMetadata.variables, job.mvu.baseline);
}

export async function finishMvu(job, result, isCurrent) {
    if (!job.mvu) return;
    const preserveStopped = () => {
        if (!job.stopRequested) return false;
        if (!isCurrent()) throw new Error('聊天已变化，未覆盖新的内容');
        // An incomplete reply must not launch another analysis after Stop.
        // Keep parsed variables if ready, otherwise retain the turn baseline.
        job.mvuPending = mvuBusy() || !isMvuData(activeData(result));
        if (job.mvuPending) replaceFields(slot(result), job.mvu.baseline);
        return true;
    };
    if (preserveStopped()) return;
    // Native generation awaits receive/render listeners. Also wait for MVU versions
    // that keep their extra-model request running outside the native generation.
    while (mvuBusy()) {
        if (preserveStopped()) return;
        if (!isCurrent()) throw new Error('重写已取消或聊天已变化');
        await backgroundDelay(100);
    }
    if (preserveStopped()) return;
    if (!isCurrent()) throw new Error('重写已取消或聊天已变化');
    if (!isMvuData(activeData(result))) {
        // MVU throttles MESSAGE_RECEIVED. A very fast second reply may therefore
        // miss inline parsing; use its public parser, with the same baseline.
        if (!globalThis.Mvu?.parseMessage || !/<UpdateVariable\b|<JSONPatch\b|_\.(?:set|add|assign|insert|remove|delete)\s*\(/i.test(result.mes)) {
            throw new Error('重写稿未收到 MVU 变量快照，已保留原稿；请确认 MVU 变量解析已完成');
        }
        const data = await globalThis.Mvu.parseMessage(result.mes, structuredClone(job.mvu.baseline));
        if (!isCurrent()) throw new Error('重写已取消或聊天已变化');
        if (!isMvuData(data)) throw new Error('MVU 未返回可用的重写变量，已保留原稿');
        replaceFields(slot(result), pick(data));
    }
}

export function restoreMvu(job, { restoreChat = true } = {}) {
    const transaction = mvuTransaction(job.source);
    if (!transaction || transaction.id !== job.id) return;
    replaceFields(slot(job.source, transaction.swipe), transaction.original);
    if (restoreChat && getContext().chatMetadata) {
        getContext().chatMetadata.variables ??= {};
        replaceFields(getContext().chatMetadata.variables, transaction.chat);
    }
    delete job.source.extra[TRANSACTION];
}

export function commitMvu(job, final) {
    if (!job.mvu) return;
    if (job.mvu.mirrorChat || isMvuData(getContext().chatMetadata?.variables)) {
        getContext().chatMetadata.variables ??= {};
        replaceFields(getContext().chatMetadata.variables, pick(activeData(final)));
    }
    delete final.extra?.[TRANSACTION];
}

export function mergeSwipeVariables(original, result, final) {
    if (!original.variables && !result.variables) return;
    final.variables = original.swipes.map((_, i) => structuredClone(original.variables?.[i] ?? {}));
    final.variables.push(structuredClone(activeData(result) ?? {}));
}

export function syncMvuChat(message) {
    const data = activeData(message);
    const variables = getContext().chatMetadata?.variables;
    if (!isMvuData(data) || !isMvuData(variables)) return false;
    replaceFields(variables, pick(data));
    return true;
}
