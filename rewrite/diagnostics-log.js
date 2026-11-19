const KEY = 'connexHub.rewrite.diagnostics.v1';

// Lifecycle errors may contain echoed content. Keep bounded, conventional error text only.
export function safeRewriteError(value) {
    const text = String(value || '鏈煡閿欒').replace(/[\r\n]+/g, ' ')
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
        .replace(/https?:\/\/[^\s<>"']+/gi, url => {
            try { const parsed = new URL(url); return parsed.origin + parsed.pathname; }
            catch { return '[url]'; }
        });
    return text.slice(0, 500);
}

export function createRewriteDiagnostics(storage) {
    let record = null;
    try {
        const stored = storage || globalThis.localStorage;
        record = JSON.parse(stored?.getItem(KEY) || 'null');
    } catch { /* Invalid or unavailable data is ignored. */ }
    function save() {
        try {
            const stored = storage || globalThis.localStorage;
            if (record) stored?.setItem(KEY, JSON.stringify(record)); else stored?.removeItem(KEY);
        }
        catch { /* Storage failure must not affect rewriting. */ }
    }
    return {
        record(event) {
            if (!event || typeof event.rewriteId !== 'string') return;
            record = {
                rewriteId: event.rewriteId.slice(0, 100),
                outcome: ['completed', 'stopped', 'cancelled', 'failed'].includes(event.outcome) ? event.outcome : 'unknown',
                connectionName: String(event.connectionName || '').slice(0, 160),
                model: String(event.model || '').slice(0, 180),
                updatedAt: new Date().toISOString(),
            };
            if (event.error) record.error = safeRewriteError(event.error);
            save();
        },
        latest: () => record,
        clear() { record = null; save(); },
    };
}
