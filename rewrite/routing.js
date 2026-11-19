export const REWRITE_REQUEST = Symbol.for('connexHub.rewrite.request');

export function nativeSource(conn, sources) {
    return conn.format === 'claude' ? sources.CLAUDE : sources.CUSTOM;
}

export function resolveRewriteConnection(setting, connections, mainId) {
    const id = setting?.connectionId || mainId;
    const conn = connections.find(item => item.id === id);
    if (!conn) throw new Error('重写连接不存在，请在 ConnexHub 中重新选择');
    if (!String(conn.endpoint || '').trim()) throw new Error('重写连接尚未填写端点');
    if (!String(conn.model || '').trim() && !String(setting?.model || '').trim()) throw new Error('重写连接尚未填写模型');
    return { conn: structuredClone(conn), model: String(setting?.model || '').trim() || String(conn.model || '').trim() };
}

// Manual and automatic rewriting share the same optional second API route.
// Resolve it here so the transaction can freeze the selected connection and model.
export function resolveManualRewriteConnection(connections, mainId, settings = {}) {
    // The optional second connection is the explicit rewrite target for both
    // automatic and manual runs. An empty selection means the current connection.
    return resolveRewriteConnection(settings, connections, mainId);
}

export function applyRewriteMetadata(body, conn, model, sources) {
    body.chat_completion_source = nativeSource(conn, sources);
    body.model = model;
    // Prevent credentials and transport options from the first protocol leaking into the second.
    for (const field of ['custom_url', 'reverse_proxy', 'proxy_password', 'secret_id', 'custom_include_headers',
        'custom_include_body', 'custom_exclude_body', 'custom_prompt_post_processing']) delete body[field];
}

// Attribution is explicit: symbols never reach JSON, so the diagnostic layer is told
// which request window is active instead of inspecting the serialized body.
export function rewriteDiagnosticMetadata(context) {
    if (!context) return { phase: 'initial' };
    const metadata = { phase: 'rewrite', rewriteId: context.rewriteId, connectionName: context.connectionName };
    if (typeof context.automatic === 'boolean') metadata.automatic = context.automatic;
    return metadata;
}
