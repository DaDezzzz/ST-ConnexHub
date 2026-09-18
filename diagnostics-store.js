// Stores only the latest bounded summary produced by diagnostics.js, never request/response bodies.
export const LOGS_KEY = 'connexHub.diagnostics.logs.v1';
export const ENABLED_KEY = 'connexHub.diagnostics.enabled.v1';
const SCHEMA_VERSION = 2;
const MAX_CHARS = 256 * 1024;
const RESET_HOUR = 6;

/** Local calendar period whose boundary is 06:00, resilient to DST and service downtime. */
export function diagnosticsPeriod(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid diagnostics clock');
    const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate() - (date.getHours() < RESET_HOUR ? 1 : 0));
    return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
}

export function millisecondsUntilNextReset(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid diagnostics clock');
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), RESET_HOUR, 0, 0, 0);
    if (date >= next) next.setDate(next.getDate() + 1);
    return Math.max(1, next.getTime() - date.getTime());
}

function validRecord(record) {
    return record && typeof record.id === 'string' && typeof record.outcome === 'string'
        && Number.isFinite(Date.parse(record.startedAt));
}

function latestRecord(records) {
    return records.filter(validRecord).sort((a, b) => {
        const aTime = Date.parse(a.updatedAt || a.startedAt);
        const bTime = Date.parse(b.updatedAt || b.startedAt);
        return aTime - bTime;
    }).pop() || null;
}

export function createDiagnosticsStore({ getStorage = () => globalThis.localStorage,
    now = () => Date.now() } = {}) {
    let state = 'available';
    let lastPruned = false;
    const currentPeriod = () => diagnosticsPeriod(new Date(now()));

    function readArchive() {
        const raw = getStorage().getItem(LOGS_KEY);
        if (!raw) return { record: null, period: currentPeriod(), migrated: false };
        if (raw.length > MAX_CHARS) throw new Error('Oversized diagnostic archive');
        const data = JSON.parse(raw);
        if (data?.schemaVersion === SCHEMA_VERSION) {
            const record = data.record ?? latestRecord(Array.isArray(data.records) ? data.records : []);
            if (typeof data.period !== 'string' || (record !== null && !validRecord(record))) {
                throw new Error('Invalid diagnostic archive');
            }
            return { record, period: data.period, migrated: false };
        }
        // v1 migration: retain only its latest valid record when it belongs to the current 06:00 period.
        if (data?.schemaVersion === 1 && Array.isArray(data.records)) {
            return { record: latestRecord(data.records), period: null, migrated: true };
        }
        throw new Error('Invalid diagnostic archive');
    }

    function writeRecord(record) {
        const kept = record || null;
        // Keep records[0] as a compatibility view for existing local inspection tools.
        const text = JSON.stringify({ schemaVersion: SCHEMA_VERSION, period: currentPeriod(),
            record: kept, records: kept ? [kept] : [] });
        if (text.length > MAX_CHARS) throw new Error('Oversized diagnostic record');
        getStorage().setItem(LOGS_KEY, text);
        state = 'saved';
    }

    function normalizeRecord(record) {
        return record?.inFlight ? {
            ...record, previousOutcome: record.outcome, outcome: 'incomplete_snapshot', inFlight: false,
        } : record;
    }

    return {
        load() {
            let enabled = false;
            let records = [];
            lastPruned = false;
            try {
                enabled = getStorage().getItem(ENABLED_KEY) === 'true';
                const archive = readArchive();
                const periodMatches = archive.migrated
                    ? diagnosticsPeriod(new Date(archive.record?.startedAt || now())) === currentPeriod()
                    : archive.period === currentPeriod();
                if (periodMatches && archive.record) records = [normalizeRecord(archive.record)];
                else if (archive.record) lastPruned = true;
                if (getStorage().getItem(LOGS_KEY)) writeRecord(records[0] || null);
            } catch {
                state = 'unavailable';
            }
            return { enabled, records, pruned: lastPruned };
        },
        save(records) {
            try {
                const incoming = latestRecord(Array.isArray(records) ? records : []);
                const archive = readArchive();
                const existing = archive.period === currentPeriod() ? archive.record : null;
                // Best-effort cross-tab protection: a late snapshot must not replace a newer request.
                const record = latestRecord([existing, incoming].filter(Boolean));
                writeRecord(record);
                return true;
            } catch {
                state = 'unavailable';
                return false;
            }
        },
        clearIfPeriodChanged() {
            try {
                const archive = readArchive();
                const changed = archive.migrated || archive.period !== currentPeriod();
                if (changed) writeRecord(null);
                lastPruned = changed && Boolean(archive.record);
                return lastPruned;
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
        get lastPruned() { return lastPruned; },
    };
}
