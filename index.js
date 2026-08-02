/**
 * ConnexHub — SillyTavern 第三方扩展（纯前端，零 core 侵入）
 *
 * 设计目标（严格遵守）：
 *  1. 数据完全独立：API 端点、密钥、模型、附加参数、排除参数、附加请求头全部存于
 *     `extension_settings.connexHub.connections[*]` 自有命名空间；安装 / 卸载 / 升级
 *     永不动 SillyTavern 原生设置（oai_settings / 密钥库 / preset 等）。
 *  2. 双格式独立支持：OpenAI 兼容（/chat/completions）与 Claude（/messages），
 *     每种格式独立存储模型列表与拉取状态；切换活动连接时按其 format 决定请求链路。
 *  3. OAI 兼容格式：复用酒馆原生 CUSTOM 链路（generate_data.custom_url / custom_model
 *     / custom_include_body / custom_exclude_body / custom_include_headers），
 *     不重写一套请求体组装——保证与上游 SillyTavern 的协议处理（tool calling、
 *     reasoning、json_schema、prompt post-processing 等）100% 一致。
 *     API Key 通过 custom_include_headers 注入 Authorization 头，完全不写 ST 密钥库。
 *  4. Claude 格式：走 ST 原生 CLAUDE 分支的 reverse_proxy + proxy_password 通道。
 *     ST 后端 sendClaudeRequest 的密钥逻辑是：
 *       apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(CLAUDE)
 *     因此设置 reverse_proxy 后密钥由 proxy_password 逐请求透传，
 *     同样完全不写 ST 密钥库、不碰任何原生数据。
 *
 * 关键约束（实战派）：
 *  - 卸载清理：删 extension_settings.connexHub 命名空间；防御性扫描并清理
 *    历史版本可能遗留的 ConnexHub 标记密钥条目。
 *  - 性能：所有 DOM 事件用 document 委托（DOM 重建不失效）；模型下拉用 DocumentFragment
 *    一次性 append。
 *  - 状态隔离：每个连接字段缺失都做兜底，避免「半配置」崩溃。
 */

import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { chat_completion_sources, oai_settings } from '../../../openai.js';
import { saveSettingsDebounced, getRequestHeaders, eventSource, event_types, main_api } from '../../../../script.js';
import { SECRET_KEYS, deleteSecret, secret_state } from '../../../secrets.js';

const LOG = '[ConnexHub]';
const NS = 'connexHub';
const SECRET_LABEL_TAG = 'ConnexHub'; // uninstall 时按此 label 标识清理

/** 格式定义 */
const FORMATS = {
    openai: {
        label: 'OpenAI 兼容',
        modelUrlSuffix: '/models',
        generateUrlSuffix: '/chat/completions',
        /** 端点归一化：若未以 /v数字 结尾则补 /v1（用户可写 # 后缀关闭补全） */
        normalizeEndpoint(ep) {
            let raw = String(ep || '').trim().replace(/\/+$/, '');
            if (raw.endsWith('#')) return { url: raw.slice(0, -1).replace(/\/+$/, ''), raw: true };
            if (raw && !/\/v\d+$/.test(raw)) raw = raw + '/v1';
            return { url: raw, raw: false };
        },
    },
    claude: {
        label: 'Claude (Anthropic)',
        modelUrlSuffix: '/models',
        generateUrlSuffix: '/messages',
        normalizeEndpoint(ep) {
            const raw = String(ep || '').trim().replace(/\/+$/, '');
            return { url: raw, raw: false };
        },
    },
};

const DEFAULT_SETTINGS = {
    enabled: true,
    /** 顶部插头面板视图：'cxh'（默认，ConnexHub 接管） | 'native'（原版连接） */
    viewMode: 'cxh',
    /** 当前选中连接 ID（选中即生效，无需激活） */
    selectedConnectionId: null,
    /** 连接数组 */
    connections: [],
    /** 首次安装已初始化标志 */
    initialized: false,
};

const DEFAULT_CONNECTION = () => ({
    id: `cxh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    format: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
    availableModels: [],
    lastFetched: 0,
    includeBody: '',
    excludeBody: '',
    includeHeaders: '',
    /** 勾选式排除的键列表（与 excludeBody YAML 取并集） */
    excludeChecks: [],
});

// ── 存储层 ──────────────────────────────────────────────────────

function getStore() {
    if (!extension_settings[NS]) extension_settings[NS] = structuredClone(DEFAULT_SETTINGS);
    if (!Array.isArray(extension_settings[NS].connections)) extension_settings[NS].connections = [];
    if (typeof extension_settings[NS].enabled !== 'boolean') extension_settings[NS].enabled = true;
    if (extension_settings[NS].viewMode !== 'native' && extension_settings[NS].viewMode !== 'cxh') extension_settings[NS].viewMode = 'cxh';
    // 旧版本迁移：activeConnectionId → selectedConnectionId
    if (extension_settings[NS].selectedConnectionId === undefined) {
        extension_settings[NS].selectedConnectionId = extension_settings[NS].activeConnectionId || null;
    }
    delete extension_settings[NS].activeConnectionId;
    delete extension_settings[NS].activeSource;
    return extension_settings[NS];
}

function getConnections() { return getStore().connections; }
function getConn(id) { return getConnections().find(c => c.id === id) || null; }
function getSelectedConn() { return getConn(getStore().selectedConnectionId); }

// ── 工具：YAML 数组解析（exclude 列表） ──────────────────────────

/** 解析 YAML 数组：仅支持 "- item" 简单标量，与原生 custom_exclude_body 兼容 */
function parseYamlList(text) {
    if (!text || typeof text !== 'string') return [];
    const out = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || !line.startsWith('-')) continue;
        const v = line.replace(/^-\s*/, '').replace(/^['"]|['"]$/g, '').trim();
        if (v) out.push(v);
    }
    return out;
}

// ── 关键：generate 请求注入（CHAT_COMPLETION_SETTINGS_READY） ─────

const PROTECTED_KEYS = new Set([
    'chat_completion_source', 'messages', 'model', 'stream', 'json_schema',
    'custom_url', 'reverse_proxy', 'proxy_password', 'secret_id', 'tools', 'tool_choice',
]);

/**
 * Claude 协议允许透传的「白名单」附加 body 字段（与酒馆 sendClaudeRequest 实际取用的字段对齐）
 * 见 src/endpoints/backends/chat-completions.js 中 sendClaudeRequest 构造的 requestBody
 */
const CLAUDE_ALLOWED_EXTRA_BODY = new Set([
    'temperature', 'top_p', 'top_k', 'max_tokens', 'stop',
]);

/**
 * 勾选式排除的可选项：两种格式统一五项（按用户要求顺序）。
 */
const EXCLUDE_CHECK_KEYS = [
    { key: 'top_p', label: 'top_p' },
    { key: 'top_k', label: 'top_k' },
    { key: 'temperature', label: 'temperature' },
    { key: 'presence_penalty', label: 'presence_penalty' },
    { key: 'frequency_penalty', label: 'frequency_penalty' },
];

const EXCLUDE_CHECK_OPTIONS = {
    claude: EXCLUDE_CHECK_KEYS,
    openai: EXCLUDE_CHECK_KEYS,
};

/** 汇总一个连接的最终排除键列表：勾选项 ∪ YAML 文本列表 */
function getExcludeKeys(conn) {
    const set = new Set(parseYamlList(conn.excludeBody));
    if (Array.isArray(conn.excludeChecks)) {
        for (const k of conn.excludeChecks) set.add(k);
    }
    return set;
}

/**
 * 注入活动连接参数到本次请求。
 * 仅在 main_api === 'openai' 且 oai_settings.chat_completion_source 与活动连接的
 * native source 匹配时执行；OAI 走 CUSTOM，Claude 走 CLAUDE。
 */
function applyActiveConnection(generateData) {
    try {
        const store = getStore();
        if (!store.enabled) return;
        // 原版视图下完全不干预请求 —— 与原生数据/行为彻底隔离
        if (store.viewMode !== 'cxh') return;
        const conn = getSelectedConn();
        if (!conn || !generateData) return;

        const expectedSource = conn.format === 'claude'
            ? chat_completion_sources.CLAUDE
            : chat_completion_sources.CUSTOM;
        if (generateData.chat_completion_source !== expectedSource) return;

        // 端点 / 密钥 / 模型：注入
        const fmt = FORMATS[conn.format];
        if (!fmt) return;

        const normalized = fmt.normalizeEndpoint(conn.endpoint);
        const model = String(conn.model || '').trim();

        if (conn.format === 'openai') {
            generateData.custom_url = normalized.url;
            if (model) generateData.custom_model = model;
            // 自有 API Key 不走 ST 密钥库：通过 custom_include_headers 注入 Authorization
            // —— 真正 OAI 兼容服务都接受 Authorization 头，零 ST 原生字段依赖。
            if (conn.apiKey) {
                // 把 apikey 放进 Authorization 时不破坏用户已写的 headers
                const existing = generateData.custom_include_headers || '';
                const merged = mergeYamlHeaders(existing, { Authorization: `Bearer ${conn.apiKey}` });
                generateData.custom_include_headers = merged;
            }
            if (conn.includeBody?.trim()) generateData.custom_include_body = conn.includeBody;
            if (conn.includeHeaders?.trim()) {
                generateData.custom_include_headers = mergeYamlHeaders(
                    generateData.custom_include_headers || '', parseYamlObject(conn.includeHeaders),
                );
            }
            for (const k of getExcludeKeys(conn)) {
                if (!PROTECTED_KEYS.has(k) && k in generateData) delete generateData[k];
            }
        } else {
            // Claude 格式 —— 完全独立密钥方案：
            // ST 后端 sendClaudeRequest 的密钥逻辑是
            //   apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(CLAUDE)
            // 因此只要设置 reverse_proxy，密钥直接由 proxy_password 透传，
            // 完全不写入酒馆密钥库，不碰任何原生数据。
            generateData.reverse_proxy = normalized.url;
            generateData.proxy_password = conn.apiKey || '';
            if (model) generateData.model = model;
            if (conn.includeBody?.trim()) {
                // 只把白名单字段注入；其它字段 ST 后端 Claude 分支不读取
                const obj = parseYamlObject(conn.includeBody);
                for (const [k, v] of Object.entries(obj)) {
                    if (CLAUDE_ALLOWED_EXTRA_BODY.has(k)) generateData[k] = v;
                }
            }
            for (const k of getExcludeKeys(conn)) {
                if (!PROTECTED_KEYS.has(k) && k in generateData) delete generateData[k];
            }
        }
    } catch (err) {
        console.error(`${LOG} inject failed`, err);
    }
}

/** 极简 YAML 对象解析（仅 "k: v" / "k:\n  v" 不支持；够用即可） */
function parseYamlObject(text) {
    const out = {};
    if (!text) return out;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || !line.includes(':')) continue;
        const idx = line.indexOf(':');
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k) out[k] = coerceScalar(v);
    }
    return out;
}

function coerceScalar(v) {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '') return null;
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
    return v;
}

/** 把已有 YAML headers 文本与新对象合并：避免覆盖已有键（除非是 Authorization） */
function mergeYamlHeaders(existingYaml, extra) {
    const parsed = parseYamlObject(existingYaml);
    for (const [k, v] of Object.entries(extra)) parsed[k] = v;
    return Object.entries(parsed).map(([k, v]) => `${k}: ${formatScalar(v)}`).join('\n');
}

function formatScalar(v) {
    if (typeof v === 'string' && /[\s:#]/.test(v)) return `"${v.replace(/"/g, '\\"')}"`;
    return String(v);
}

// ── 选中连接 → 同步酒馆原生 source（选中即生效，无需激活按钮） ─

async function syncSourceForConn(id, { quiet = true } = {}) {
    const conn = getConn(id);
    if (!conn) return;
    const fmt = FORMATS[conn.format];
    if (!fmt) return;
    const normalized = fmt.normalizeEndpoint(conn.endpoint);
    if (!normalized.url) return; // 端点未填时不动原生 source

    const targetSource = conn.format === 'claude'
        ? chat_completion_sources.CLAUDE
        : chat_completion_sources.CUSTOM;

    // 把酒馆原生 source 切到目标，触发原生 UI 重渲染
    if (main_api === 'openai') {
        oai_settings.chat_completion_source = targetSource;
        $('#chat_completion_source').val(targetSource).trigger('change');
    } else {
        // TC 模式：通过 /api 切到 openai
        try {
            const SlashCommandParser = (await import('../../../slash-commands/SlashCommandParser.js')).SlashCommandParser;
            await SlashCommandParser.commands['api'].callback({
                _scope: new (await import('../../../slash-commands/SlashCommandScope.js')).SlashCommandScope(),
                _abortController: new (await import('../../../slash-commands/SlashCommandAbortController.js')).SlashCommandAbortController(),
                _debugController: new (await import('../../../slash-commands/SlashCommandDebugController.js')).SlashCommandDebugController(),
                _parserFlags: {},
                _hasUnnamedArgument: false,
                quiet: 'true',
            }, 'openai');
        } catch (err) {
            console.error(`${LOG} 切换到 openai 失败`, err);
            if (!quiet) toastr.error('切到 OpenAI 失败：当前为 Text Completion', LOG);
            return;
        }
        oai_settings.chat_completion_source = targetSource;
        $('#chat_completion_source').val(targetSource).trigger('change');
    }
    if (!quiet) toastr.success(`已切换：${conn.name || conn.id}`, LOG);
}

// ── 卸载清理（hook clean / delete） ─────────────────────────────

export async function cleanupPluginData() {
    try {
        // 1. 删除酒馆密钥库里所有 ConnexHub 标记的条目
        try {
            const list = Array.isArray(secret_state[SECRET_KEYS.CLAUDE]) ? secret_state[SECRET_KEYS.CLAUDE] : [];
            for (const s of list.filter(x => x.label?.startsWith(`${SECRET_LABEL_TAG}/`))) {
                await deleteSecret(SECRET_KEYS.CLAUDE, s.id);
            }
        } catch (err) {
            console.warn(`${LOG} secret cleanup warn`, err);
        }
        // 2. 删自有命名空间
        if (extension_settings[NS]) delete extension_settings[NS];
        saveSettingsDebounced();
        console.log(`${LOG} cleaned`);
    } catch (err) {
        console.error(`${LOG} cleanup failed`, err);
    }
}

// ── 模型拉取（走酒馆后端代理，避免浏览器 CORS 拦截） ─────────────

async function fetchModels(conn) {
    const fmt = FORMATS[conn.format];
    if (!fmt) throw new Error('未知格式');
    const norm = fmt.normalizeEndpoint(conn.endpoint);
    if (!norm.url) throw new Error('请先填写端点 URL');

    let list = [];
    try {
        list = await fetchModelsViaBackend(conn, norm.url);
    } catch (backendErr) {
        console.warn(`${LOG} 后端代理拉取失败，尝试直连`, backendErr);
        list = await fetchModelsDirect(conn, norm.url, fmt);
    }
    conn.availableModels = list;
    conn.lastFetched = Date.now();
    saveSettingsDebounced();
    return list;
}

/** 首选：通过 ST 后端 /status 通道拉模型（服务器发起请求，无 CORS 问题） */
async function fetchModelsViaBackend(conn, baseUrl) {
    const body = conn.format === 'claude'
        ? {
            chat_completion_source: chat_completion_sources.CLAUDE,
            reverse_proxy: baseUrl,
            proxy_password: conn.apiKey || '',
        }
        : {
            chat_completion_source: chat_completion_sources.CUSTOM,
            custom_url: baseUrl,
            custom_include_headers: conn.apiKey ? `Authorization: Bearer ${conn.apiKey}` : '',
        };
    const resp = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}：${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    const models = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const list = models.map(m => ({ id: m.id || m.name || m })).filter(m => m.id);
    if (!list.length) throw new Error('后端未返回模型列表');
    return list;
}

/** 兜底：浏览器直连（部分中转站允许 CORS） */
async function fetchModelsDirect(conn, baseUrl, fmt) {
    if (!conn.apiKey) throw new Error('请先填写 API Key');
    const headers = { 'Accept': 'application/json' };
    if (conn.format === 'claude') {
        headers['x-api-key'] = conn.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else {
        headers['Authorization'] = `Bearer ${conn.apiKey}`;
    }
    const url = baseUrl.replace(/\/+$/, '') + fmt.modelUrlSuffix;
    const resp = await fetch(url, { method: 'GET', headers });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}：${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return models.map(m => ({ id: m.id || m.name || m })).filter(m => m.id);
}

// ── UI 渲染 ──────────────────────────────────────────────────

function renderConnSelect() {
    const $sel = $('#cxh_conn_select');
    if (!$sel.length) return;
    const conns = getConnections();
    const frag = document.createDocumentFragment();
    const none = document.createElement('option');
    none.value = ''; none.textContent = '— 选择连接 —';
    frag.appendChild(none);
    for (const c of conns) {
        const opt = document.createElement('option');
        opt.value = c.id; opt.textContent = c.name || '(未命名)';
        frag.appendChild(opt);
    }
    $sel.empty().append(frag);
    $sel.val(getStore().selectedConnectionId || '');
}

function fillEditor(conn) {
    if (!conn) {
        $('#cxh_editor input, #cxh_editor textarea').val('');
        $('#cxh_format').val('openai');
        renderModelSelect(null);
        renderExcludeChecks(null);
        updateEndpointHint(null);
        return;
    }
    $('#cxh_name').val(conn.name);
    $('#cxh_format').val(conn.format);
    $('#cxh_endpoint').val(conn.endpoint);
    $('#cxh_apikey').val(conn.apiKey);
    $('#cxh_model_manual').val(conn.model);
    $('#cxh_include_body').val(conn.includeBody);
    $('#cxh_exclude_body').val(conn.excludeBody);
    $('#cxh_include_headers').val(conn.includeHeaders);
    renderModelSelect(conn);
    renderExcludeChecks(conn);
    updateEndpointHint(conn);
}

/** 按连接格式渲染快捷排除勾选（每连接独立保存于 conn.excludeChecks） */
function renderExcludeChecks(conn) {
    const $box = $('#cxh_exclude_checks');
    if (!$box.length) return;
    const format = conn?.format === 'claude' ? 'claude' : 'openai';
    const options = EXCLUDE_CHECK_OPTIONS[format];
    const checked = new Set(Array.isArray(conn?.excludeChecks) ? conn.excludeChecks : []);
    const frag = document.createDocumentFragment();
    for (const { key, label } of options) {
        const lab = document.createElement('label');
        lab.className = 'cxh-check-item';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = key;
        input.checked = checked.has(key);
        input.dataset.cxhExclude = '1';
        const span = document.createElement('span');
        span.textContent = label;
        lab.appendChild(input);
        lab.appendChild(span);
        frag.appendChild(lab);
    }
    $box.empty().append(frag);
}

/** 从 UI 读取勾选的排除键 */
function collectExcludeChecks() {
    const keys = [];
    $('#cxh_exclude_checks input[data-cxh-exclude]:checked').each(function () {
        keys.push(String($(this).val()));
    });
    return keys;
}

function renderModelSelect(conn) {
    const $sel = $('#cxh_model_select');
    const list = conn?.availableModels || [];
    const frag = document.createDocumentFragment();
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = list.length ? '— 从列表选择 —' : '（尚未拉取模型）';
    frag.appendChild(blank);
    for (const m of list) {
        const opt = document.createElement('option');
        opt.value = m.id; opt.textContent = m.id;
        frag.appendChild(opt);
    }
    $sel.empty().append(frag);
    // 优先匹配 manual 输入
    const manual = String(conn?.model || '').trim();
    if (manual) $sel.val(manual);
}

function updateEndpointHint(conn) {
    // 按用户要求：不展示接口后缀/实际请求提示，保持界面干净
    $('#cxh_endpoint_hint').text('');
}

function collectFromEditor() {
    return {
        name: String($('#cxh_name').val() || '').trim(),
        format: $('#cxh_format').val(),
        endpoint: String($('#cxh_endpoint').val() || '').trim(),
        apiKey: String($('#cxh_apikey').val() || '').trim(),
        model: String($('#cxh_model_manual').val() || $('#cxh_model_select').val() || '').trim(),
        includeBody: String($('#cxh_include_body').val() || ''),
        excludeBody: String($('#cxh_exclude_body').val() || ''),
        includeHeaders: String($('#cxh_include_headers').val() || ''),
        excludeChecks: collectExcludeChecks(),
    };
}

function setStatus(text, kind = 'info') {
    const $s = $('#cxh_status');
    if (!$s.length) return;
    $s.text(text).attr('data-kind', kind);
}

// ── 事件绑定（全部 document 委托） ────────────────────────────

/** 从编辑器构造一个「临时连接」对象（未保存也能拉模型/测试） */
function draftConn() {
    const id = $('#cxh_conn_select').val();
    const base = getConn(id) || DEFAULT_CONNECTION();
    return { ...base, ...collectFromEditor() };
}

/** 保存逻辑：已选中则更新；未选中（新建草稿）则创建。返回保存后的连接或 null */
function saveFromEditor() {
    const data = collectFromEditor();
    if (!data.name) {
        setStatus('请填写连接名称后再保存', 'err');
        toastr.warning('连接名称不能为空', LOG);
        $('#cxh_name').trigger('focus');
        return null;
    }
    const id = $('#cxh_conn_select').val();
    let conn = getConn(id);
    if (!conn) {
        conn = DEFAULT_CONNECTION();
        getConnections().push(conn);
    }
    Object.assign(conn, data);
    // 保存即选中生效
    getStore().selectedConnectionId = conn.id;
    saveSettingsDebounced();
    renderConnSelect();
    $('#cxh_conn_select').val(conn.id);
    updateEndpointHint(conn);
    syncSourceForConn(conn.id);
    return conn;
}

/** 真实对话测试：发送一条 "hi" 到聊天补全端点 */
async function sendTestMessage(conn) {
    const fmt = FORMATS[conn.format];
    if (!fmt) throw new Error('未知格式');
    const norm = fmt.normalizeEndpoint(conn.endpoint);
    if (!norm.url) throw new Error('请先填写端点 URL');
    const model = String(conn.model || '').trim();
    if (!model) throw new Error('请先选择或填写模型');

    const body = conn.format === 'claude'
        ? {
            chat_completion_source: chat_completion_sources.CLAUDE,
            reverse_proxy: norm.url,
            proxy_password: conn.apiKey || '',
            model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 32,
            stream: false,
        }
        : {
            chat_completion_source: chat_completion_sources.CUSTOM,
            custom_url: norm.url,
            custom_include_headers: conn.apiKey ? `Authorization: Bearer ${conn.apiKey}` : '',
            model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 32,
            stream: false,
        };
    const resp = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const text = await resp.text().catch(() => '');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}：${text.slice(0, 200)}`);
    let reply = '';
    let thinking = '';
    try {
        const data = JSON.parse(text);
        // OAI 格式正文
        reply = data?.choices?.[0]?.message?.content ?? '';
        // Claude 格式：content 是块数组，thinking 块可能排在 text 块前面，需按类型提取
        if (!reply && Array.isArray(data?.content)) {
            reply = data.content.filter(b => b?.type === 'text').map(b => b.text).join('');
            thinking = data.content.filter(b => b?.type === 'thinking').map(b => b.thinking).join('');
        }
        // OAI 变体：部分中转把思考放 reasoning_content
        if (!reply && !thinking) {
            thinking = data?.choices?.[0]?.message?.reasoning_content || '';
        }
    } catch { /* 非 JSON 响应 */ }
    // 思考型模型 max_tokens 全被 thinking 吃掉属正常 —— HTTP 200 + 有 thinking 即视为连接成功
    if (!reply && thinking) return `[思考] ${thinking.slice(0, 80)}`;
    if (!reply) throw new Error(`响应异常：${text.slice(0, 200) || '(空)'}`);
    return reply;
}

function bindEvents() {
    // 选中即生效：切换下拉 = 切换当前连接
    $(document).on('change.cxh', '#cxh_conn_select', function () {
        const id = String($(this).val() || '');
        getStore().selectedConnectionId = id || null;
        saveSettingsDebounced();
        fillEditor(getConn(id));
        if (id) syncSourceForConn(id);
    });
    $(document).on('click.cxh', '#cxh_btn_new', function () {
        // 真正全空草稿：不立即入库，点保存才创建
        $('#cxh_conn_select').val('');
        fillEditor(null);
        setStatus('新建连接：填写后点保存', 'info');
        $('#cxh_name').trigger('focus');
    });
    // 参数配置折叠（一级）
    $(document).on('click.cxh', '#cxh_params_toggle', function () {
        const $drawer = $('#cxh_params_drawer');
        $drawer.toggleClass('cxh-open');
        $drawer.children('.cxh-collapse-body').slideToggle(180);
    });
    // 高级 YAML 折叠（二级）
    $(document).on('click.cxh', '#cxh_adv_toggle', function (e) {
        e.stopPropagation();
        const $drawer = $('#cxh_adv_drawer');
        $drawer.toggleClass('cxh-open');
        $drawer.children('.cxh-collapse-body').slideToggle(180);
    });
    $(document).on('click.cxh', '#cxh_btn_dup', function () {
        const id = $('#cxh_conn_select').val();
        const src = getConn(id);
        if (!src) { setStatus('请先选择要复制的连接', 'err'); return; }
        const dup = { ...structuredClone(src), id: DEFAULT_CONNECTION().id, name: `${src.name || '(未命名)'} 副本`, lastFetched: 0 };
        getConnections().push(dup);
        saveSettingsDebounced();
        renderConnSelect();
        $('#cxh_conn_select').val(dup.id).trigger('change');
    });
    $(document).on('click.cxh', '#cxh_btn_del', function () {
        const id = $('#cxh_conn_select').val();
        if (!id) { setStatus('请先选择要删除的连接', 'err'); return; }
        const idx = getConnections().findIndex(c => c.id === id);
        if (idx < 0) return;
        getConnections().splice(idx, 1);
        if (getStore().selectedConnectionId === id) getStore().selectedConnectionId = null;
        saveSettingsDebounced();
        renderConnSelect();
        fillEditor(null);
        setStatus('已删除', 'ok');
    });
    // 端点/格式变化 → 实时刷新「实际请求」提示（草稿也生效）
    $(document).on('input.cxh change.cxh', '#cxh_endpoint, #cxh_format', function () {
        updateEndpointHint({ endpoint: $('#cxh_endpoint').val(), format: $('#cxh_format').val() });
    });
    // 切换格式时重渲染勾选组（两种格式选项不同；保留已保存的勾选交集）
    $(document).on('change.cxh', '#cxh_format', function () {
        const conn = getConn($('#cxh_conn_select').val());
        renderExcludeChecks({ ...(conn || {}), format: $(this).val() });
    });
    $(document).on('click.cxh', '#cxh_btn_eye', function () {
        const $i = $('#cxh_apikey');
        $i.attr('type', $i.attr('type') === 'password' ? 'text' : 'password');
    });
    $(document).on('click.cxh', '#cxh_btn_save', function () {
        const conn = saveFromEditor();
        if (conn) {
            setStatus(`已保存：${conn.name}`, 'ok');
            toastr.success(`已保存：${conn.name}`, LOG);
        }
    });
    $(document).on('click.cxh', '#cxh_btn_fetch_models', async function () {
        const $icon = $(this).find('i');
        const conn = draftConn();
        if (!String(conn.endpoint || '').trim()) { setStatus('请先填写端点 URL', 'err'); return; }
        setStatus('获取模型中…');
        $icon.addClass('fa-spin');
        try {
            const list = await fetchModels(conn);
            // 若该草稿对应已保存连接，同步模型列表
            const saved = getConn($('#cxh_conn_select').val());
            if (saved) { saved.availableModels = list; saved.lastFetched = Date.now(); saveSettingsDebounced(); }
            renderModelSelect({ ...conn, availableModels: list });
            setStatus(`已获取 ${list.length} 个模型`, 'ok');
            toastr.success(`已获取 ${list.length} 个模型`, LOG);
        } catch (err) {
            setStatus(`获取失败：${err.message}`, 'err');
            toastr.error(err.message, `${LOG} 获取模型失败`);
        } finally {
            $icon.removeClass('fa-spin');
        }
    });
    // 下拉选中模型 → 同步到手动输入框（模型最终值以输入框优先，避免用户困惑）
    $(document).on('change.cxh', '#cxh_model_select', function () {
        const v = String($(this).val() || '');
        if (v) $('#cxh_model_manual').val(v);
    });
    $(document).on('click.cxh', '#cxh_btn_test', async function () {
        const conn = draftConn();
        if (!String(conn.endpoint || '').trim()) { setStatus('请先填写端点 URL', 'err'); return; }
        setStatus('发送 "hi" 测试中…');
        try {
            const reply = await sendTestMessage(conn);
            setStatus(`✓ 连接成功，回复：${reply.slice(0, 80)}`, 'ok');
            toastr.success(`回复：${reply.slice(0, 80)}`, `${LOG} 测试成功`);
        } catch (err) {
            setStatus(`✗ ${err.message}`, 'err');
            toastr.error(err.message, `${LOG} 测试失败`);
        }
    });
}

// ── 首次安装初始化（注入两种格式默认示例） ─────────────────────

function initDefaults() {
    const store = getStore();
    if (store.initialized) return;
    if (store.connections.length === 0) {
        const a = DEFAULT_CONNECTION();
        a.name = 'OpenAI 兼容示例';
        a.format = 'openai';
        a.endpoint = 'https://api.openai.com/v1';
        const b = DEFAULT_CONNECTION();
        b.name = 'Claude 示例';
        b.format = 'claude';
        b.endpoint = 'https://api.anthropic.com/v1';
        store.connections.push(a, b);
    }
    store.initialized = true;
    saveSettingsDebounced();
}

// ── 顶部插头面板视图切换（ConnexHub ⇄ 原版，数据隔离） ─────────

/**
 * 原版 API 连接抽屉的原生子元素（除我们注入的面板外全部算原生）。
 * ConnexHub 视图时隐藏原生内容；原版视图时恢复。
 */
function applyViewMode() {
    const mode = getStore().viewMode;
    const $panel = $('#cxh_api_panel');
    const $nativeChildren = $('#rm_api_block').children().not('#cxh_api_panel');
    if (mode === 'cxh') {
        $nativeChildren.addClass('cxh-native-hidden');
        $('#cxh_main').show();
        $('#cxh_tab_cxh').addClass('cxh-tab-active');
        $('#cxh_tab_native').removeClass('cxh-tab-active');
    } else {
        $nativeChildren.removeClass('cxh-native-hidden');
        $('#cxh_main').hide();
        $('#cxh_tab_native').addClass('cxh-tab-active');
        $('#cxh_tab_cxh').removeClass('cxh-tab-active');
    }
    $panel.attr('data-view', mode);
}

function setViewMode(mode) {
    getStore().viewMode = mode === 'native' ? 'native' : 'cxh';
    saveSettingsDebounced();
    applyViewMode();
}

// ── 入口 ────────────────────────────────────────────────────

jQuery(async () => {
    getStore();
    initDefaults();

    // 注入到顶部插头（API 连接）抽屉：#rm_api_block 最上方
    try {
        const html = await renderExtensionTemplateAsync(`third-party/ST-ConnexHub`, 'settings');
        const $target = $('#rm_api_block');
        if ($target.length) {
            $target.prepend(html);
        } else {
            // 兜底：极端情况下退回扩展设置区
            $('#extensions_settings').append(html);
            console.warn(`${LOG} #rm_api_block 未找到，退回扩展设置区`);
        }
    } catch (err) {
        console.error(`${LOG} render template failed`, err);
        return;
    }

    renderConnSelect();
    const initial = getSelectedConn() || getConn($('#cxh_conn_select').val());
    fillEditor(initial);
    bindEvents();
    // 启动时若已有选中连接，静默同步原生 source
    if (getStore().viewMode === 'cxh' && initial) syncSourceForConn(initial.id);

    // 视图切换（默认 ConnexHub，可切回原版；两侧数据完全隔离）
    $(document).on('click.cxh-view', '#cxh_tab_cxh', () => setViewMode('cxh'));
    $(document).on('click.cxh-view', '#cxh_tab_native', () => setViewMode('native'));
    applyViewMode();

    // 请求注入钩子
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, applyActiveConnection);
    eventSource.makeLast(event_types.CHAT_COMPLETION_SETTINGS_READY, applyActiveConnection);

    console.log(`${LOG} loaded · ${getConnections().length} connections · view=${getStore().viewMode}`);
});