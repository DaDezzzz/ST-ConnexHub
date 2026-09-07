// Stores only the bounded summaries produced by diagnostics.js, never request/response bodies.
export const LOGS_KEY = 'connexHub.diagnostics.logs.v1';
export const ENABLED_KEY = 'connexHub.diagnostics.enabled.v1';
const MAX_RECORDS = 30;
const MAX_CHARS = 256 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function createDiagnosticsStore({ getStorage = () => globalThis.localStorage,
    now = () => Date.now() } = {}) {
    let state = 'available';
    function read() {
        const raw = getStorage().getItem(LOGS_KEY);
        if (!raw) return [];
        if (raw.length > MAX_CHARS) throw new Error('Oversized diagnostic archive');
        const data = JSON.parse(raw);
        if (data?.schemaVersion !== 1 || !Array.isArray(data.records)) throw new Error('Invalid diagnostic archive');
        return data.records.filter(record => record && typeof record.id === 'string'
            && typeof record.outcome === 'string' && Number.isFinite(Date.parse(record.startedAt))
            && Date.parse(record.startedAt) >= now() - MAX_AGE_MS).slice(-MAX_RECORDS);
    }
    function write(records) {
        const kept = records.slice(-MAX_RECORDS);
        let text = JSON.stringify({ schemaVersion: 1, records: kept });
        while (text.length > MAX_CHARS && kept.length) {
            kept.shift();
            text = JSON.stringify({ schemaVersion: 1, records: kept });
        }
        getStorage().setItem(LOGS_KEY, text);
        state = 'saved';
    }
    return {
        load() {
            let enabled = false;
            let records = [];
            try {
                enabled = getStorage().getItem(ENABLED_KEY) === 'true';
                records = read();
                // A saved in-flight snapshot is evidence of missing observation, not proof of a network abort.
                records = records.map(record => record.inFlight ? {
                    ...record, previousOutcome: record.outcome, outcome: 'incomplete_snapshot', inFlight: false,
                } : record);
                if (getStorage().getItem(LOGS_KEY)) write(records);
            } catch {
                state = 'unavailable';
            }
            return { enabled, records };
        },
        save(records) {
            try {
                // Merge by globally unique request ID so separate tabs do not normally overwrite each other's logs.
                let existing = [];
                try { existing = read(); } catch { /* Replace an invalid archive with current safe summaries. */ }
                const merged = new Map(existing.map(record => [record.id, record]));
                for (const record of records) {
                    const prior = merged.get(record.id);
                    if (!prior || (record.updatedAt || record.startedAt) >= (prior.updatedAt || prior.startedAt)) {
                        merged.set(record.id, record);
                    }
                }
                const recent = [...merged.values()].filter(record => Date.parse(record.startedAt) >= now() - MAX_AGE_MS);
                recent.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
                write(recent);
                return true;
            } catch {
                state = 'unavailable';
                return false;
            }
        },
        setEnabled(enabled) {
            try {
                getStorage().setItem(ENABLED_KEY, String(Boolean(enabled)));
                if (state === 'unavailable') state = 'available';
                return true;
            } catch {
                state = 'unavailable';
                return false;
            }
        },
        clear() {
            try {
                getStorage().removeItem(LOGS_KEY);
                state = 'available';
                return true;
            } catch {
                state = 'unavailable';
                return false;
            }
        },
        get state() { return state; },
    };
}