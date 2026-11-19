import { createDiagnostics } from './diagnostics.js';
import { createDiagnosticsStore, millisecondsUntilNextReset } from './diagnostics-store.js';
import { createRewriteDiagnostics } from './rewrite/diagnostics-log.js';

const OUTCOMES = {
    pending: '请求进行中',
    incomplete_snapshot: '上次记录未完成（页面关闭/刷新或记录中断，原因未定）',
    completed: '已收到协议结束标志/完整响应',
    api_error: '接口返回错误',
    http_error: 'HTTP 错误',
    request_error: '请求未建立或发送失败',
    stream_error: '读取响应流失败',
    aborted: '请求被取消（不一定是手动停止）',
    consumer_cancelled: '响应读取被取消',
    eof_without_end_marker: '连接结束但缺少协议结束标志',
    eof_with_finish_reason: '有结束原因，但缺少完整结束标志',
    malformed_sse: '流中含无效 JSON（即使收到结束标志也不能判作正常）',
    unexpected_response: '响应格式异常',
    unexpected_non_sse: '预期流式响应，实际收到非 SSE 响应',
    body_not_inspected: '响应过长，仅记录接收统计',
    body_unavailable: '响应已被其他消费者读取',
    empty_response: '无响应体',
    observation_disabled: '已停止记录（未中止请求）',
    observation_failed: '诊断解析失败（未中止请求）',
    observation_unavailable: '无法观测响应（未中止请求）',
};

const REWRITE_OUTCOMES = { pending: '进行中', completed: '已完成', stopped: '已停止', cancelled: '已取消', failed: '失败' };

function timeOf(record) {
    return new Date(record.startedAt || record.updatedAt).toLocaleTimeString();
}

function briefRequest(record) {
    const request = record.request || {};
    const status = record.response?.status ? `HTTP ${record.response.status}` : OUTCOMES[record.outcome] || record.outcome;
    const kind = record.phase === 'rewrite'
        ? record.automatic === true ? '自动重写请求' : record.automatic === false ? '手动重写请求' : '重写请求'
        : '普通请求';
    return `${timeOf(record)} [${kind}] ${record.connectionName || '(未命名)'} · ${request.model || '(未指定模型)'} · ${status}`;
}

function briefRewrite(record) {
    const kind = record.automatic === true ? '自动重写' : record.automatic === false ? '手动重写' : '重写';
    const status = record.status ? `HTTP ${record.status}` : REWRITE_OUTCOMES[record.outcome] || record.outcome;
    return `${timeOf(record)} [${kind}] ${record.connectionName || '(未命名)'} · ${record.model || '(未指定模型)'} · ${status}`;
}

function detailRequest(record) {
    const details = [];
    for (const error of [record.error, record.transportError, record.abortReason, ...(record.browserErrors || [])]) {
        if (!error) continue;
        details.push(`${error.name || error.type || '错误'}: ${error.message || error.code || '无详细信息'}`);
        if (Array.isArray(error.frames) && error.frames.length) details.push(error.frames.join('\n'));
    }
    return details.join('\n').slice(0, 3000);
}

/** 默认关闭；只在当前浏览器、当前站点保存有界诊断摘要，不同步酒馆账户配置。 */
export function mountDiagnosticsPanel(root, { shouldRecord, getSecrets, getRequestMetadata, host = globalThis,
    baseUrl = globalThis.location?.href, getStorage = () => host.localStorage } = {}) {
    if (!root) return null;
    const checkbox = root.querySelector('#cxh_diagnostics_enabled');
    const exportButton = root.querySelector('#cxh_diagnostics_export');
    const clearButton = root.querySelector('#cxh_diagnostics_clear');
    const status = root.querySelector('#cxh_diagnostics_status');
    const output = root.querySelector('#cxh_diagnostics_output');
    if (!checkbox || !exportButton || !clearButton || !status || !output) return null;
    const downloads = new Map();
    let resetTimer = null;
    const store = createDiagnosticsStore({ getStorage });
    const rewriteLog = createRewriteDiagnostics();
    const restored = store.load();
    let detailed = restored.enabled;
    const logger = createDiagnostics({ host, baseUrl, shouldRecord, getSecrets, getRequestMetadata,
        initialRecords: restored.records, onChange: persistAndRender,
        shouldPersist: () => detailed });

    function persistAndRender() {
        if (logger.persistentCount) store.save(logger.getPersistentRecords().slice(-1));
        render();
    }

    function render() {
        checkbox.checked = detailed;
        exportButton.disabled = clearButton.disabled = logger.count === 0 && !rewriteLog.latest();
        const records = logger.getRecords();
        const latest = records[records.length - 1];
        const lifecycle = rewriteLog.latest();
        const result = latest ? ` · 最近：${OUTCOMES[latest.outcome] || latest.outcome}${latest.phase === 'rewrite' ? '（重写）' : ''}` : '';
        const rewriteResult = lifecycle ? ` · 重写：${lifecycle.outcome}${lifecycle.error ? `（${lifecycle.error}）` : ''}` : '';
        const storage = !detailed ? '简要日志仅在本页展示'
            : store.state === 'unavailable' ? '详细日志保存不可用，请关闭页面前导出'
                : '详细日志仅保存最近一次 · 每日 06:00 清理';
        status.textContent = `${detailed ? '详细记录中' : '仅简要展示'} · ${storage}${result}${rewriteResult}`;
        const lines = [
            ...records.map(record => ({ at: record.startedAt, text: briefRequest(record), detail: detailRequest(record) })),
            ...rewriteLog.getRecords().map(record => ({ at: record.updatedAt, text: briefRewrite(record), detail: record.stack || record.error })),
        ].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-10);
        output.value = lines.length ? lines.map(line => `${line.text}${line.detail ? `\n${line.detail}` : ''}`).join('\n\n') : '暂无日志。发送请求或执行重写后，这里会显示简要信息。';
        output.scrollTop = output.scrollHeight;
    }

    function clearExpired() {
        if (!store.clearIfPeriodChanged()) return false;
        logger.clear();
        render();
        return true;
    }

    function scheduleReset() {
        if (resetTimer !== null) host.clearTimeout?.(resetTimer);
        // Recalculate after every run so local DST/time changes do not accumulate interval drift.
        resetTimer = host.setTimeout?.(() => {
            clearExpired();
            scheduleReset();
        }, millisecondsUntilNextReset(new Date())) ?? null;
    }

    function resume() {
        clearExpired();
        scheduleReset();
    }
    function change(event) {
        if (event.target !== checkbox) return;
        try {
            detailed = checkbox.checked;
            store.setEnabled(detailed);
            if (detailed && logger.persistentCount) store.save(logger.getPersistentRecords().slice(-1));
            else if (!detailed) store.clear();
            render();
        } catch {
            checkbox.checked = detailed;
            status.textContent = '无法切换诊断状态；聊天请求未被主动取消。';
        }
    }
    function releaseDownload(url) {
        clearTimeout(downloads.get(url));
        downloads.delete(url);
        URL.revokeObjectURL(url);
    }
    function click(event) {
        if (event.target.closest('#cxh_diagnostics_clear')) {
            store.clear();
            logger.clear();
            rewriteLog.clear();
            render();
        } else if (event.target.closest('#cxh_diagnostics_export') && (logger.count || rewriteLog.latest())) {
            let url;
            const link = root.ownerDocument.createElement('a');
            try {
                const exported = JSON.parse(logger.exportJson());
                exported.briefRequests = logger.getRecords();
                exported.rewriteLifecycle = rewriteLog.getRecords();
                url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json;charset=utf-8' }));
                link.href = url;
                link.download = `connexhub-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
                // Safari 需要已挂载的下载链接；仅导出时延迟回收，不在收流期间运行定时任务。
                root.ownerDocument.body.appendChild(link);
                link.click();
                downloads.set(url, setTimeout(() => releaseDownload(url), 10000));
            } catch {
                if (url) URL.revokeObjectURL(url);
                status.textContent = '日志导出失败，记录仍在本页；请勿刷新，可再次点击导出。';
            } finally {
                link.remove();
            }
        }
    }
    root.addEventListener('change', change);
    root.addEventListener('click', click);
    // Flush only safe metadata on page exit; do not stop or cancel the underlying stream.
    const flush = () => { if (logger.persistentCount) store.save(logger.getPersistentRecords().slice(-1)); };
    host.addEventListener?.('pagehide', flush);
    host.addEventListener?.('pageshow', resume);
    root.ownerDocument.addEventListener?.('visibilitychange', resume);
    if (restored.enabled) {
        try { logger.enable(); }
        catch { store.setEnabled(false); }
    }
    logger.enable();
    scheduleReset();
    render();
    return {
        clear() { store.clear(); logger.clear(); rewriteLog.clear(); },
        recordRewrite(event) { rewriteLog.record(event); render(); },
        dispose() {
            root.removeEventListener('change', change);
            root.removeEventListener('click', click);
            host.removeEventListener?.('pagehide', flush);
            host.removeEventListener?.('pageshow', resume);
            root.ownerDocument.removeEventListener?.('visibilitychange', resume);
            if (resetTimer !== null) host.clearTimeout?.(resetTimer);
            logger.disable();
            store.setEnabled(false);
            store.clear();
            logger.clear();
            rewriteLog.clear();
            for (const url of [...downloads.keys()]) releaseDownload(url);
        },
    };
}
