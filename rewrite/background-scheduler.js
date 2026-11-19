// Queue lifecycle work as a task, not a paint callback. A worker-backed retry
// avoids relying exclusively on aggressively throttled window timers while the
// page is hidden. A frozen/discarded browser page can still suspend everything.
let delayWorker, delayWorkerUrl, delayUnsupported = false, nextDelay = 0;
const delays = new Map();

export function backgroundDelay(milliseconds) {
    return new Promise(resolve => {
        const id = ++nextDelay;
        delays.set(id, { resolve });
        const complete = () => {
            const pending = delays.get(id);
            if (!pending) return;
            delays.delete(id); pending.resolve();
        };
        if (document.hidden && !delayUnsupported) {
            try {
                if (!delayWorker) {
                    delayWorkerUrl = URL.createObjectURL(new Blob([
                        'onmessage = ({data}) => setTimeout(() => postMessage(data.id), data.delay);',
                    ], { type: 'application/javascript' }));
                    delayWorker = new Worker(delayWorkerUrl);
                    delayWorker.onmessage = ({ data }) => {
                        const pending = delays.get(data);
                        if (pending) { delays.delete(data); pending.resolve(); }
                    };
                    delayWorker.onerror = () => { delayUnsupported = true; disposeBackgroundDelays(); };
                }
                delayWorker.postMessage({ id, delay: Math.max(1000, milliseconds) });
                return;
            } catch { delayUnsupported = true; }
        }
        delays.get(id).timer = setTimeout(complete, milliseconds);
    });
}

export function disposeBackgroundDelays() {
    delayWorker?.terminate(); delayWorker = null;
    if (delayWorkerUrl) { URL.revokeObjectURL(delayWorkerUrl); delayWorkerUrl = null; }
    for (const pending of delays.values()) { clearTimeout(pending.timer); pending.resolve(); }
    delays.clear();
}

export function createBackgroundScheduler(action) {
    let disposed = false, ticket = 0, queued = false, timer, worker, workerUrl;
    let workerUnavailable = false;
    const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
    const run = generation => {
        if (disposed || generation !== ticket) return;
        queued = false;
        action();
    };
    if (channel) channel.port1.onmessage = event => run(event.data);
    const request = () => {
        if (disposed || queued) return;
        queued = true;
        const generation = ticket;
        if (channel) channel.port2.postMessage(generation);
        else queueMicrotask(() => run(generation));
    };
    const ensureWorker = () => {
        if (worker || workerUnavailable) return worker;
        try {
            workerUrl = URL.createObjectURL(new Blob([`let timer;
                onmessage = ({data}) => {
                    clearTimeout(timer);
                    if (data.delay != null) timer = setTimeout(() => postMessage(data.ticket), data.delay);
                };`], { type: 'application/javascript' }));
            worker = new Worker(workerUrl);
            worker.onmessage = event => { if (event.data === ticket) request(); };
            worker.onerror = () => {
                workerUnavailable = true;
                worker?.terminate(); worker = null;
                if (!disposed) timer = setTimeout(request, 1000);
            };
        } catch {
            workerUnavailable = true;
            worker = null;
        }
        return worker;
    };
    const cancel = () => {
        ticket++;
        queued = false;
        clearTimeout(timer); timer = undefined;
        worker?.postMessage({ ticket });
    };
    return { request, cancel, retry(delay = 200) {
        if (disposed) return;
        clearTimeout(timer);
        if (document.hidden && ensureWorker()) worker.postMessage({ ticket, delay: Math.max(1000, delay) });
        else timer = setTimeout(request, delay);
    }, dispose() {
        cancel(); disposed = true;
        worker?.terminate(); worker = null;
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        channel?.port1.close(); channel?.port2.close();
    } };
}
