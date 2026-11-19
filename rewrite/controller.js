import * as core from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { SWIPE_STATE } from '../../../../constants.js';
import { hasPendingFileAttachment } from '../../../../chats.js';
import { getRegexedString, regex_placement } from '../../../regex/engine.js';
import { createRewriteUI } from './ui.js';
import { resolveManualRewriteConnection } from './routing.js';
import { createBackgroundScheduler, disposeBackgroundDelays } from './background-scheduler.js';
import { mvuBusy, mvuFeedback, prepareMvu, resetMvuFeedback, finishMvu, syncMvuChat, waitMvuWindow } from './mvu-compat.js';
import { canRewriteInplace, prepareInplace, generateInplace, commitInplace, restoreInplace,
    recoverInplace, ownsInplace, updateInplacePrompts, clearInplacePrompts, getInplaceReply, rememberStoppedInplace } from './inplace-rewrite.js';
import { REVISION, TEMP, remember, collapse, restore, recover, markStaging, liveReply, showStaging, versionLink, jumpVersion, ownsTail, rememberStoppedFallback } from './revisions.js';

export const DEFAULT_FEEDBACK = `请检查上一轮正文，并在保留用户意图、已发生事实和角色设定的前提下重写。
只修正确有必要的问题，不为追求变化而更换剧情走向，不新增未经铺垫的关键设定、人物或事件。
重点检查：
1. 角色只能依据亲历、被告知或可合理推断的信息行动。不得知道他人未公开的内心、秘密、离场事件或作者视角信息；合理猜测应体现不确定性。
2. 角色的言行、情绪和关系变化应有前文依据，符合性格与处境，避免突然转变、脸谱化和过度反应。
3. 不替用户角色擅自作出重要决定或完成关键行动；不重复已有内容，不无故跳过正在进行的事件。
4. 台词符合说话者身份和当时情绪，避免解释已知信息、长篇说教和多人使用相同口吻。
5. 删除重复、堆砌和无效修饰，保持场景连续、动作清楚、详略得当。
只输出完整重写正文，不输出审校过程、问题清单、修改说明或前后对比。`;

let installed = false;
let ui;
let cycle;
let pending;
let running;
let scheduler;
let sequence = 0;
let mvuReadyAt = 0;
let status = '等待下一次生成';
let deps;
const subscriptions = [];
const settings = () => deps.getSettings();
const feedbackText = () => [settings().baseFeedback || DEFAULT_FEEDBACK, settings().feedback]
    .filter(text => text && text.trim()).join('\n\n');

function chatKey(ctx = getContext()) {
    return `${ctx.groupId ?? ''}|${ctx.characterId ?? ''}|${ctx.getCurrentChatId() ?? ''}`;
}

function isSingleChat(ctx) {
    return !ctx.groupId && ctx.characterId != null;
}

function composerBusy() {
    return Boolean(document.getElementById('send_textarea')?.value.trim()) || hasPendingFileAttachment();
}

/**
 * A swipe is only really in progress while the native UI shows it. `body[data-swiping]`
 * is set and cleared next to `swipeState`, so it can leak for the same reason; the
 * send button is the independent signal, because generation re-enables it on finish.
 */
function swipeLooksActive() {
    const sendButton = document.getElementById('send_but');
    if (sendButton && (sendButton.disabled || sendButton.classList?.contains('disabled'))) return true;
    const swipeArrows = document.querySelectorAll('#chat .mes:last-child .swipe_right, #chat .mes:last-child .swipe_left');
    return [...swipeArrows].some(element => element.classList?.contains('disabled'));
}

function rewriteBlocker(ctx = getContext()) {
    if (core.isChatSaving) return '正在保存聊天';
    const stream = ctx.streamingProcessor;
    if (stream?.isFinished || stream?.isFinalizing || stream?.isStopped) return '正在完成回复收尾';
    if (core.is_send_press || stream) return '正在生成回复';
    // Native swipeGenerate() sets swipeState = SWIPING and then bails out with a
    // bare `return` when the target message DOM is not valid, never resetting the
    // state. Trusting that enum alone left the chat permanently "swiping": the
    // rewrite button stayed disabled and the automatic queue retried forever.
    // Only block when a swipe is actually observable in the UI.
    if (core.swipeState === SWIPE_STATE.SWIPING && swipeLooksActive()) return '正在切换回复版本';
    // Native messageEdit() hides the normal buttons and shows the edit controls,
    // and this ST version does assign SWIPE_STATE.EDITING. Keep both checks: the
    // enum catches programmatic edits, the DOM check catches the editor itself.
    if (core.swipeState === SWIPE_STATE.EDITING
        || [...document.querySelectorAll('#chat .mes_edit_buttons')].some(element => {
            // The default state comes from the stylesheet (`display: none`), so the
            // inline style is an empty string on every message. Treating that as
            // "visible" marked the whole chat as being edited, which disabled the
            // rewrite button and stalled the automatic queue forever.
            const display = String(element.style?.display ?? '').trim().toLowerCase();
            return display !== '' && display !== 'none';
        })
        || document.querySelector('#chat :is(.edit_textarea, .reasoning_edit_textarea, .mes_edit_textarea)')) return '正在编辑消息';
    if (settings().mvu && mvuBusy()) return '正在解析 MVU 变量';
    return '';
}

function isIdle(ctx = getContext()) {
    return !rewriteBlocker(ctx);
}

function setStatus(text) {
    status = text;
    ui?.refresh();
}

function clearPending() {
    scheduler?.cancel();
    cycle?.notice?.finish(false);
    if (cycle) cycle.notice = null;
    pending = null;
}

const beginNotice = () => globalThis[Symbol.for('st.generation-notifications.sequence.v1')]?.begin?.() ?? null;

function matches(attempt, ctx = getContext(), checkText = true) {
    const last = ctx.chat.at(-1);
    return chatKey(ctx) === attempt.key && isSingleChat(ctx)
        && last === attempt.message && !last.is_user && !last.is_system
        && ctx.chat.length - 1 === attempt.index
        && (last.swipe_id ?? 0) === attempt.swipeId && (!checkText || last.mes === attempt.text);
}

function latestReply(ctx = getContext()) {
    const message = ctx.chat.at(-1);
    if (!isSingleChat(ctx) || !message || message.is_user || message.is_system
        || !message.mes?.trim() || message.mes.trim() === '...') return null;
    return { key: chatKey(ctx), index: ctx.chat.length - 1, message, text: message.mes, swipeId: message.swipe_id ?? 0 };
}

function view() {
    const ctx = getContext();
    const reply = running && chatKey(ctx) === running.key && ctx.chat[running.index] === running.source
        ? liveReply(running) ?? { ...running.attempt, message: running.source, preview: !running.cancelled }
        : latestReply(ctx);
    const saved = reply?.message.extra?.[REVISION];
    const blocker = rewriteBlocker(ctx);
    return {
        reply, link: running ? null : versionLink(reply), status, busy: Boolean(running),
        cancelled: Boolean(running?.cancelled), stopping: Boolean(running?.stopRequested),
        stopped: Boolean(saved?.stopped), networkLabelAtStart: running?.networkLabelAtStart,
        receiving: Boolean(running?.generating && !running.generationFinished && !running.replyReceived
            && !running.stopRequested && !running.cancelled),
        canBrowse: Boolean(running && !running.cancelled && chatKey(ctx) === running.key
            && ctx.chat[running.index] === running.source),
        idle: !blocker, blocker, composerBusy: composerBusy(), timing: running?.timing ?? saved?.timing,
    };
}

async function openVersions() {
    const job = running;
    if (!job || !sameJob(job) || getContext().chat[job.index] !== job.source) return;
    try {
        const { openReadOnlySwipePicker } = await import('../../../../swipe-picker.js');
        if (typeof openReadOnlySwipePicker !== 'function') {
            globalThis.toastr?.info('当前酒馆版本未提供生成期间的原生版本记录。');
            return;
        }
        if (!sameJob(job) || getContext().chat[job.index] !== job.source) return;
        const swipes = job.original.swipes?.length ? [...job.original.swipes] : [job.original.mes];
        swipes[job.attempt.swipeId] = job.attempt.text;
        await openReadOnlySwipePicker(job.index, { ...job.original, swipes, swipe_id: job.attempt.swipeId }, { depth: 0 });
    } catch (error) {
        console.warn('[ConnexHub rewrite] Opening version history', error);
        globalThis.toastr?.warning('未能打开原生版本记录。');
    }
}

function manualRewrite(attempt) {
    if (!attempt || running) return;
    const ctx = getContext();
    const reply = latestReply(ctx);
    if (!reply || !matches(attempt, ctx, false) || !isIdle(ctx) || composerBusy()) {
        ui?.refresh();
        return;
    }
    clearPending();
    if (cycle) cycle.attempted = true;
    void rewrite(reply, false);
}

async function jump(attempt, target) {
    if (!attempt || running || !isIdle() || !matches(attempt)) return;
    clearPending();
    try { await jumpVersion(attempt, target); }
    catch (error) {
        console.error('[ConnexHub rewrite] Version switch', error);
        globalThis.toastr?.warning('版本切换未完成，请等保存结束后重试。');
    } finally { ui?.refresh(); }
}

function subscribe(type, handler) {
    if (!type) return;
    getContext().eventSource.on(type, handler);
    subscriptions.push([type, handler]);
}

function queue() {
    if (!installed || !settings().auto || !pending || running) return;
    scheduler?.request();
}

function drainQueue() {
    if (!installed || !settings().auto || !pending || running) return;
    const attempt = pending;
    const ctx = getContext();
    if (!cycle || cycle.id !== attempt.cycleId || cycle.attempted || !matches(attempt, ctx, false)) {
        clearPending();
        setStatus('聊天或回复已变化，已取消本次自动重写');
        return;
    }
    const blocker = rewriteBlocker(ctx);
    if (blocker) { setStatus(blocker); scheduler?.retry(); return; }
    if (composerBusy()) { setStatus('输入框有草稿或附件，暂缓自动重写'); scheduler?.retry(); return; }
    attempt.text = attempt.message.mes;
    if (!attempt.text?.trim() || attempt.text.trim() === '...') { clearPending(); return; }
    cycle.attempted = true;
    const notice = cycle.notice;
    cycle.notice = null;
    clearPending();
    void rewrite(attempt, true, notice);
}

function sameJob(job) {
    return installed && running === job && !job.cancelled && chatKey() === job.key;
}

function stoppedReply(job) {
    if (job.inplace) return getInplaceReply(job);
    if (!ownsTail(job)) return null;
    const ctx = getContext();
    for (let index = ctx.chat.length - 1; index > job.index + 1; index--) {
        const message = ctx.chat[index];
        if (!message.is_user && !message.is_system && message.mes?.trim() && message.mes.trim() !== '...') return message;
    }
    return null;
}

function appendFeedback(ctx, text, job) {
    const message = {
        name: ctx.name1,
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: ctx.substituteParams(getRegexedString(text, regex_placement.USER_INPUT)),
        extra: { [TEMP]: { id: job.id, sourceIndex: job.index } },
    };
    if (!message.mes.trim()) throw new Error('修改意见被用户输入正则清空');
    remember(job);
    const avatar = core.user_avatar;
    if (avatar && Object.hasOwn(ctx.powerUserSettings?.personas ?? {}, avatar)) {
        message.force_avatar = ctx.getThumbnailUrl('persona', avatar);
    }
    const index = ctx.chat.length;
    ctx.chat.push(message);
    if (ctx.chatMetadata) ctx.chatMetadata.tainted = true;
    ctx.addOneMessage(message, { scroll: false });
    return { message, index };
}

async function rewrite(attempt, automatic = true, notice = null) {
    if (running) { notice?.finish(false); return; }
    const ctx = getContext();
    const feedback = feedbackText();
    if (!feedback) { notice?.finish(false); setStatus('当前没有可用的修改意见'); return; }
    if (!matches(attempt, ctx) || !isIdle(ctx) || composerBusy()) { notice?.finish(false); return; }

    let route;
    try {
        route = deps.beginRoute(resolveManualRewriteConnection(deps.getConnections(), deps.getMainConnectionId(), settings()));
    } catch (error) {
        notice?.finish(false);
        setStatus(error.message);
        globalThis.toastr?.warning(error.message);
        ui?.refresh();
        return;
    }

    const now = Date.now();
    const firstStarted = Date.parse(attempt.message.gen_started);
    const job = {
        id: route.id,
        key: attempt.key, index: attempt.index, attempt, source: attempt.message,
        original: structuredClone(attempt.message), prefix: ctx.chat.slice(0, attempt.index),
        cancelled: false, generating: false, automatic, notice: notice ?? beginNotice(), route,
        timing: { startedAt: automatic && Number.isFinite(firstStarted) ? Math.min(firstStarted, now) : now, rewriteStartedAt: now },
    };
    running = job;
    job.phase = 'prepare';
    setStatus('正在准备重写');
    try {
        if (settings().mvu) prepareMvu(job);
        const instruction = feedback + (job.mvu ? mvuFeedback : '');
        if (canRewriteInplace()) {
            await prepareInplace(job, instruction);
        } else {
            const { message, index } = appendFeedback(ctx, instruction, job);
            job.feedback = message;
            if (settings().mvu) resetMvuFeedback(job);
            markStaging(job);
            await ctx.saveChat();
            if (!sameJob(job) || getContext().chat.at(-1) !== message) throw new Error('重写已取消或聊天已变化');
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_SENT, index);
            if (!sameJob(job) || getContext().chat.at(-1) !== message) throw new Error('重写已取消或聊天已变化');
            await ctx.eventSource.emit(ctx.eventTypes.USER_MESSAGE_RENDERED, index);
            if (!sameJob(job) || getContext().chat.at(-1) !== message) throw new Error('重写已取消或聊天已变化');
            if (settings().mvu) resetMvuFeedback(job);
        }
        if (!sameJob(job)) throw new Error('重写已取消或聊天已变化');
        if (composerBusy()) throw new Error('输入框中出现了新草稿或附件，本次重写已停止');
        if (job.mvu) {
            setStatus('等待 MVU 解析窗口');
            await waitMvuWindow(mvuReadyAt, () => sameJob(job)
                && (job.inplace ? ownsInplace(job) : getContext().chat.at(-1) === job.feedback));
            if (composerBusy()) throw new Error('输入框中出现了新草稿或附件，本次重写已停止');
        }
        job.networkLabelAtStart = document.querySelector('#generation_network_status > [role="status"]');
        job.phase = 'request';
        job.generating = true;
        setStatus(`${automatic ? '正在自动重写' : '正在重写'} · ${job.route.label}`);
        // Diagnostics must never abort a rewrite: beginRoute() only guarantees { id, label, release }.
        deps.recordDiagnostic({
            rewriteId: job.id, outcome: 'pending',
            connectionName: route.conn?.name || '(未命名)', model: route.model ?? job.route?.model,
        });
        let last;
        try {
            if (job.inplace) last = await generateInplace(job);
            else { await getContext().generate('normal', { automatic_trigger: true }); last = getContext().chat.at(-1); }
        } catch (error) {
            if (!job.stopRequested || !job.stoppedDraft || !sameJob(job)) throw error;
        } finally {
            job.generationFinished = true;
        }
        if (job.stopRequested && job.stoppedDraft) last = job.stoppedDraft;
        if (!sameJob(job)) throw new Error('重写已取消或聊天已变化');
        if (!last || (!job.inplace && last === job.source) || last.is_user || last.is_system
            || !last.mes?.trim() || last.mes.trim() === '...') throw new Error('未收到可用的重写正文');
        job.phase = 'commit';
        if (!job.stopRequested) setStatus(job.mvu ? '正在整理重写稿的 MVU 变量' : '正在保存重写稿');
        await finishMvu(job, last, () => sameJob(job) && (job.inplace ? ownsInplace(job)
            : job.stopRequested ? ownsTail(job) : getContext().chat.at(-1) === last));
        job.timing.finishedAt ??= Date.now();
        if (job.inplace) await commitInplace(job, last);
        else await collapse(job, last);
        job.completed = true;
        deps.recordDiagnostic({
            rewriteId: job.id, outcome: job.stopRequested ? 'stopped' : 'completed',
            connectionName: route.conn?.name || '(未命名)', model: route.model ?? job.route?.model,
        });
        setStatus(job.stopRequested ? '已停止，当前重写稿已保留，原稿仍在上一版' : '重写已完成，原稿已保存为上一版');
        if (job.mvuPending) globalThis.toastr?.info('重写稿已保留；变量尚未解析完成，暂沿用本轮初始状态，请在正文完整后重新解析变量。');
    } catch (error) {
        console.error(`[ConnexHub rewrite] ${job.phase || 'unknown'} failed`, error);
        job.timing.finishedAt ??= Date.now();
        if (!job.settled && job.stopRequested && job.stoppedDraft && sameJob(job)) {
            setStatus('已停止，重写稿已保留，收尾未完成；请保留正文并刷新恢复');
            globalThis.toastr?.warning(status);
        } else if (!job.settled) {
            const restored = await (job.inplace ? restoreInplace(job) : restore(job))
                .catch(cleanupError => { console.error('[ConnexHub rewrite] Cleanup', cleanupError); return false; });
            if (installed && chatKey() === job.key) {
                setStatus(restored ? job.cancelled ? '重写已取消，原稿已恢复' : '重写未完成，原稿已保留'
                    : '聊天已变化，保留记录供检查，未覆盖新内容');
                if (!job.cancelled) globalThis.toastr?.warning(`${status}：${error.message}`);
            }
        } else if (installed && chatKey() === job.key) {
            setStatus('回复版本已保留，保存或界面更新未完成');
            globalThis.toastr?.warning(status);
        }
        deps.recordDiagnostic({
            rewriteId: job.id, outcome: job.cancelled ? 'cancelled' : 'failed',
            error: `[${job.phase || 'unknown'}] ${error?.message || String(error)}`,
            connectionName: route.conn?.name || '(未命名)', model: route.model,
        });
    } finally {
        clearInplacePrompts(job);
        job.route?.release();
        job.notice?.finish(Boolean(job.completed && !job.cancelled && !job.stopRequested));
        showStaging();
        if (running === job) running = null;
        ui?.sync();
        ui?.refresh();
    }
}

async function recoverInterrupted() {
    if (!installed || running || !isIdle()) return;
    try {
        const inplace = await recoverInplace();
        const recovered = inplace || await recover();
        if (recovered === 'stopped') setStatus('已恢复停止时保留的重写稿，原稿仍在上一版');
        else if (recovered) setStatus('已清理中断的重写，原稿已恢复');
    } catch (error) { console.error('[ConnexHub rewrite] Recovery', error); }
    ui?.refresh();
}

export function createRewriteController(dependencies) {
    deps = dependencies;
    return { enable, disable, refresh: () => { ui?.sync(); ui?.refresh(); } };
}

function enable() {
    if (installed) return;
    if (!document.querySelector('link[data-cxh-rewrite-style]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.dataset.cxhRewriteStyle = '1';
        link.href = '/scripts/extensions/third-party/ST-ConnexHub/rewrite/ui.css';
        document.head.append(link);
    }
    installed = true;
    scheduler = createBackgroundScheduler(drainQueue);
    const { eventTypes: events } = getContext();
    ui = createRewriteUI({
        getSettings: settings, getView: view, onVersions: openVersions, onRewrite: manualRewrite, onJump: jump,
        getConnections: deps.getConnections, getActiveConnection: deps.getActiveConnection,
        defaultFeedback: DEFAULT_FEEDBACK, onMutation: () => markStaging(running),
        onSettings: value => { Object.assign(settings(), value); deps.save(); ui?.sync(); ui?.refresh(); },
        onAuto: value => {
            settings().auto = value;
            deps.save();
            if (!value) clearPending();
            if (!running) setStatus(value ? '等待下一次生成' : '自动重写已关闭');
        },
    });
    ui.install();
    subscribe(events.APP_READY, () => { ui?.install(); void recoverInterrupted(); });
    subscribe(events.SETTINGS_LOADED, () => { ui?.sync(); ui?.refresh(); });
    for (const type of [events.CONNECTION_PROFILE_CREATED, events.CONNECTION_PROFILE_UPDATED,
        events.CONNECTION_PROFILE_DELETED, events.CONNECTION_PROFILE_LOADED,
        events.CHATCOMPLETION_MODEL_CHANGED, events.SETTINGS_UPDATED,
        events.OAI_PRESET_CHANGED_AFTER, events.PRESET_CHANGED, events.CHARACTER_DELETED]) {
        if (type) subscribe(type, () => { ui?.sync(); ui?.refresh(); });
    }
    subscribe(events.GENERATION_STARTED, (type, options, dryRun) => {
        if (dryRun) return;
        if (settings().mvu && mvuBusy()) { if (running?.inplace) clearInplacePrompts(running); return; }
        if (running) {
            if (running.inplace) {
                if (type === 'quiet') { clearInplacePrompts(running); return; }
                const rootSwipe = running.awaitingNativeSwipe && !running.nativeStarted && type === 'swipe';
                const toolContinuation = running.nativeStarted && type === 'normal' && ownsInplace(running)
                    && getContext().chat.slice(running.index + 1).some(m => Array.isArray(m.extra?.tool_invocations));
                if (rootSwipe || toolContinuation) {
                    running.replyReceived = false;
                    running.nativeStarted = true;
                    updateInplacePrompts(running, type);
                    return;
                }
            }
            if (!running.generating || !options?.automatic_trigger) {
                running.cancelled = true;
                running.timing.finishedAt ??= Date.now();
                setStatus('已由其他生成流程接管');
            }
            return;
        }
        clearPending();
        cycle = {
            id: ++sequence, key: chatKey(), attempted: false,
            eligible: [undefined, 'normal', 'regenerate', 'swipe'].includes(type) && isSingleChat(getContext()),
        };
        ui?.refresh();
    });
    subscribe(events.MESSAGE_RECEIVED, (id, type) => {
        if (running?.generating && !running.generationFinished && !running.stopRequested
            && type !== 'quiet' && sameJob(running) && Number(id) === getContext().chat.length - 1
            && (running.inplace ? ownsInplace(running) : ownsTail(running))) {
            running.replyReceived = true;
            setStatus(settings().mvu && mvuBusy() ? '正文已收到，正在解析 MVU 变量' : '正文已收到，正在完成酒馆收尾');
        }
        markStaging(running);
        ui?.refresh();
        if (running || !settings().auto || !cycle?.eligible || cycle.attempted || type === 'first_message') return;
        const ctx = getContext();
        const stream = ctx.streamingProcessor;
        if (stream?.isStopped || stream?.abortController?.signal.aborted) return;
        const message = ctx.chat.at(-1);
        const text = message?.mes;
        if (chatKey(ctx) !== cycle.key || Number(id) !== ctx.chat.length - 1 || !message
            || message.is_user || message.is_system || !text?.trim() || text.trim() === '...') return;
        pending = { cycleId: cycle.id, key: cycle.key, index: Number(id), message, text, swipeId: message.swipe_id ?? 0 };
        cycle.notice ??= beginNotice();
        queue();
    });
    subscribe(events.GENERATION_ENDED, () => {
        if (!running) mvuReadyAt = Date.now() + 3100;
        ui?.refresh();
        queue();
    });
    subscribe('generation-notifications:finished', queue);
    subscribe(events.MESSAGE_EDITED, id => {
        if (pending && Number(id) === pending.index) {
            clearPending();
            setStatus('回复已编辑，已取消本次自动重写');
        }
    });
    subscribe(events.MESSAGE_SWIPED, async id => {
        const ctx = getContext();
        if (running || Number(id) !== ctx.chat.length - 1) return;
        if (settings().mvu && syncMvuChat(ctx.chat[Number(id)])) await ctx.saveChat();
    });
    subscribe(events.GENERATION_STOPPED, generationId => {
        if (typeof generationId === 'string' && generationId) return;
        clearPending();
        cycle = null;
        const job = running;
        if (job && !job.cancelled) {
            const draft = stoppedReply(job);
            job.timing.finishedAt ??= Date.now();
            if (draft || job.settled) {
                job.stopRequested = true;
                if (draft && !job.settled) {
                    job.stoppedIndex = getContext().chat.indexOf(draft);
                    job.stoppedDraft = structuredClone(draft);
                    if (job.inplace) rememberStoppedInplace(job);
                    else rememberStoppedFallback(job);
                    clearInplacePrompts(job);
                    void getContext().saveChat().catch(error => console.error('[ConnexHub rewrite] Save stopped draft', error));
                }
            } else job.cancelled = true;
        }
        markStaging(running);
        setStatus(job?.stopRequested ? '已停止接收，正在保存当前重写稿'
            : running ? '未收到重写正文，正在恢复原稿' : '已停止生成');
    });
    for (const type of [events.CHAT_CHANGED, events.MAIN_API_CHANGED, events.OAI_PRESET_CHANGED_BEFORE,
        events.CONNECTION_PROFILE_LOADED]) {
        subscribe(type, () => {
            clearPending();
            cycle = null;
            if (running) { running.cancelled = true; running.timing.finishedAt ??= Date.now(); }
            setStatus('上下文已切换，等待下一次生成');
            ui?.sync();
            void recoverInterrupted();
        });
    }
    subscribe(events.CHAT_LOADED, () => { ui?.install(); void recoverInterrupted(); });
    for (const type of [events.MESSAGE_SWIPED, events.MESSAGE_UPDATED, events.MESSAGE_EDITED, events.MESSAGE_DELETED,
        events.CHARACTER_MESSAGE_RENDERED, events.MORE_MESSAGES_LOADED]) subscribe(type, () => ui?.refresh());
    subscribe(events.MESSAGE_SENT, id => {
        if (running && getContext().chat[Number(id)] !== running.feedback) {
            running.cancelled = true;
            running.timing.finishedAt ??= Date.now();
            showStaging();
        }
    });
    $(document).on('input.cxhRewriteComposer change.cxhRewriteComposer', '#send_textarea, #file_form_input', () => ui?.refresh());
    document.addEventListener('visibilitychange', resumeBackgroundWork);
    window.addEventListener('pageshow', resumeBackgroundWork);
    void recoverInterrupted();
}

function resumeBackgroundWork() {
    if (!installed) return;
    ui?.sync();
    ui?.refresh();
    queue();
    if (!document.hidden) void recoverInterrupted();
}

function disable() {
    installed = false;
    clearPending();
    cycle = null;
    scheduler?.dispose();
    scheduler = null;
    disposeBackgroundDelays();
    document.removeEventListener('visibilitychange', resumeBackgroundWork);
    window.removeEventListener('pageshow', resumeBackgroundWork);
    const job = running;
    if (job) {
        job.cancelled = true;
        clearInplacePrompts(job);
        if (job.generating) getContext().stopGeneration();
    }
    const ctx = getContext();
    for (const [type, handler] of subscriptions.splice(0)) ctx.eventSource.removeListener(type, handler);
    $(document).off('.cxhRewriteComposer');
    ui?.dispose();
    ui = null;
    showStaging();
}
