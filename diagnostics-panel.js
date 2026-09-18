import { createDiagnostics } from './diagnostics.js';
import { createDiagnosticsStore, millisecondsUntilNextReset } from './diagnostics-store.js';

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

/** 默认关闭；只在当前浏览器、当前站点保存有界诊断摘要，不同步酒馆账户配置。 */
export function mountDiagnosticsPanel(root, { shouldRecord, getSecrets, host = globalThis,
    baseUrl = globalThis.location?.href, getStorage = () => host.localStorage } = {}) {
    if (!root) return null;
    const checkbox = root.querySelector('#cxh_diagnostics_enabled');
    const exportButton = root.querySelector('#cxh_diagnostics_export');
    const clearButton = root.querySelector('#cxh_diagnostics_clear');
    const status = root.querySelector('#cxh_diagnostics_status');
    if (!checkbox || !exportButton || !clearButton || !status) return null;
    const downloads = new Map();
    let resetTimer = null;
    const store = createDiagnosticsStore({ getStorage });
    const restored = store.load();
    const logger = createDiagnostics({ host, baseUrl, shouldRecord, getSecrets,
        initialRecords: restored.records, onChange: persistAndRender });

    function persistAndRender() {
        if (logger.count) store.save(logger.getRecords().slice(-1));
        render();
    }

    function render() {
        checkbox.checked = logger.enabled;
        exportButton.disabled = clearButton.disabled = logger.count === 0;
        const records = logger.getRecords();
        const latest = records[records.length - 1];
        const result = latest ? ` · 最近：${OUTCOMES[latest.outcome] || latest.outcome}` : '';
        const storage = store.state === 'unavailable'
            ? '本机保存不可用，请关闭页面前导出' : '仅保留最近一次 · 每日 06:00 清理';
        status.textContent = `${logger.enabled ? '记录中' : '已关闭'} · ${storage}${result}`;
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
            if (checkbox.checked) logger.enable();
            else logger.disable();
            store.setEnabled(logger.enabled);
            render();
        } catch {
            checkbox.checked = logger.enabled;
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
        } else if (event.target.closest('#cxh_diagnostics_export') && logger.count) {
            let url;
            const link = root.ownerDocument.createElement('a');
            try {
                url = URL.createObjectURL(new Blob([logger.exportJson()], { type: 'application/json;charset=utf-8' }));
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
    const flush = () => { if (logger.count) store.save(logger.getRecords().slice(-1)); };
    host.addEventListener?.('pagehide', flush);
    host.addEventListener?.('pageshow', resume);
    root.ownerDocument.addEventListener?.('visibilitychange', resume);
    if (restored.enabled) {
        try { logger.enable(); }
        catch { store.setEnabled(false); }
    }
    scheduleReset();
    render();
    return {
        clear() { store.clear(); logger.clear(); },
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
            for (const url of [...downloads.keys()]) releaseDownload(url);
        },
    };
}
