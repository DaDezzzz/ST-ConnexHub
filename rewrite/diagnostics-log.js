// Display-only, bounded diagnostics. No storage, timers or request interception.
const LIMIT = 10;

export function safeRewriteError(value) {
    const text = String(value || '未知错误')
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
        .replace(/https?:\/\/[^\s<>"']+/gi, url => {
            try { const parsed = new URL(url); return parsed.origin + parsed.pathname; }
            catch { return '[url]'; }
        });
    return text.slice(0, 4000);
}

function compactError(error) {
    if (!error) return { message: '', stack: '' };
    const message = safeRewriteError(error.message || error).slice(0, 500);
    const stack = safeRewriteError(error.stack || '').slice(0, 3000);
    return { message, stack: (stack.startsWith(message) ? stack : `${message}\n${stack}`.trim()).slice(0, 3000) };
}

export function createRewriteDiagnostics() {
    const records = [];
    const byId = new Map();
    function trim() {
        while (records.length > LIMIT) {
            const removed = records.shift();
            if (byId.get(removed.rewriteId) === removed) byId.delete(removed.rewriteId);
        }
    }
    return {
        record(event) {
            if (!event || typeof event.rewriteId !== 'string') return;
            const id = event.rewriteId.slice(0, 100);
            const previous = byId.get(id);
            const error = compactError(event.error);
            const record = {
                rewriteId: id,
                outcome: ['pending', 'completed', 'stopped', 'cancelled', 'failed'].includes(event.outcome)
                    ? event.outcome : previous?.outcome || 'unknown',
                connectionName: String(event.connectionName || previous?.connectionName || '').slice(0, 160),
                model: String(event.model || previous?.model || '').slice(0, 180),
                updatedAt: new Date().toISOString(),
                automatic: typeof event.automatic === 'boolean' ? event.automatic : previous?.automatic,
                status: event.status ?? previous?.status ?? null,
                error: error.message || previous?.error || '',
                stack: error.stack || previous?.stack || '',
            };
            if (previous) {
                const index = records.indexOf(previous);
                if (index >= 0) records[index] = record;
                else records.push(record);
            } else records.push(record);
            byId.set(id, record);
            trim();
        },
        latest: () => records.at(-1) ?? null,
        getRecords: () => records.map(record => ({ ...record })),
        clear() { records.length = 0; byId.clear(); },
    };
}
