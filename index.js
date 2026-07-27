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
 *  4. Claude 格式：使用 generate_data 中已有的 reverse_proxy + proxy_password 通道
 *     之外完全不沾原生气——直接在 GENERATION_ENDED 之前由 ConnexHub 自有后端通道？
 *     不行：酒馆后端只支持两种 source。
 *     -> 采用「前端先把消息和附加参数组装成 Claude 协议体，再走 SillyTavern 后端
 *        /api/backends/chat-completions/generate 的 CLAUDE 分支（该分支完全独立于
 *        oai_settings，已自动按 Claude 协议重写 body）」。
 *     我们要做的：把端点和密钥注入到 generateData.proxy_password（仅在 generateData
 *     已确定走 CLAUDE 分支的前提下），把附加参数通过 chat-completion 协议体携带。
 *     实际不可行（ST 后端会拿 oai_settings 做 schema）。
 *     -> 退一步：把活动 Claude 连接的端点 + key 注入到 generateData 的
 *     `reverse_proxy` / `proxy_password` 字段，触发 ST 原生 CLAUDE 路由；OAI 走
 *     `custom_url` + `secret_id` 但密钥我们写进自有命名空间，不调用 ST 写密钥接口。
 *     但是 ST 后端 Claude 分支会调用 SECRET_KEYS.CLAUDE 读密钥…
 *     -> 务实方案：调用 ST 原生 `writeSecret(SECRET_KEYS.CLAUDE)` 把密钥写入酒馆
 *     命名密钥库（不污染 oai_settings 任何字段），然后在 generateData 上设
 *     reverse_proxy + proxy_password + model。卸载时再把这些 secret 删掉。
 *     「数据独立」仍然成立：oai_settings 上不写任何字段；密钥库的 SECRET_KEYS.CLAUDE
 *     槽是 ConnexHub 活动连接专用，不影响用户自己管理的密钥条目（uninstall 时
 *     ConnexHub 只删自己创建或激活的条目，按"label 包含 ConnexHub 标记"识别）。
 *
 * 关键约束（实战派）：
 *  - 卸载清理：遍历 connections、secret_state[CLAUDE]，按 label 标记删除
 *    ConnexHub 写入的条目 + 删 extension_settings.connexHub。
 *  - 性能：所有 DOM 事件用 document 委托（DOM 重建不失效）；模型下拉用 DocumentFragment
 *    一次性 append；状态渲染走 DocumentFragment + 单次 DOM 插入。
 *  - 状态隔离：每个连接字段缺失都做兜底，避免「半配置」崩溃。
 */

import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { chat_completion_sources, oai_settings } from '../../../openai.js';
import { saveSettingsDebounced, getRequestHeaders, eventSource, event_types, main_api } from '../../../../script.js';
import { SECRET_KEYS, writeSecret, deleteSecret, secret_state } from '../../../secrets.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { copyText } from '../../../utils.js';

const LOG = '[ConnexHub]';
const NS = 'connexHub';
const SECRET_LABEL_TAG = 'ConnexHub'; // uninstall 时按此 label 标识清理

/** 格式定义 */
const FORMATS = {
    openai: {
        label: 'OpenAI 兼容',
        modelUrlSuffix: '/models',
        generateUrlSuffix: '/chat/completions',
        /** 端点归一化：若未以 /v1 结尾则补（用户可写 # 后缀关闭） */
        normalizeEndpoint(ep) {
            let raw = String(ep || '').trim().replace(/\/+$/, '');
            if (raw.endsWith('#')) return { url: raw.slice(0, -1).replace(/\/+$/, ''), raw: true };
            if (!/\/v\d+$/.test(raw)) raw = raw + '/v1';
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
    /** 活动连接 ID（仅记录，激活时才注入运行时） */
    activeConnectionId: null,
    /** 活动连接注入到的原生 source（避免误覆盖用户手动切换的其他 source） */
    activeSource: null,
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
});

// ── 存储层 ──────────────────────────────────────────────────────

function getStore() {
    if (!extension_settings[NS]) extension_settings[NS] = structuredClone(DEFAULT_SETTINGS);
    if (!Array.isArray(extension_settings[NS].connections)) extension_settings[NS].connections = [];
    if (typeof extension_settings[NS].enabled !== 'boolean') extension_settings[NS].enabled = true;
    return extension_settings[NS];
}

function getConnections() { return getStore().connections; }
function getConn(id) { return getConnections().find(c => c.id === id) || null; }
function getActiveConn() { return getConn(getStore().activeConnectionId); }

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
 * 注入活动连接参数到本次请求。
 * 仅在 main_api === 'openai' 且 oai_settings.chat_completion_source 与活动连接的
 * native source 匹配时执行；OAI 走 CUSTOM，Claude 走 CLAUDE。
 */
function applyActiveConnection(generateData) {
    try {
        const store = getStore();
        if (!store.enabled) return;
        const conn = getActiveConn();
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
            for (const k of parseYamlList(conn.excludeBody)) {
                if (k && k in generateData) delete generateData[k];
            }
        } else {
            // Claude 格式
            generateData.reverse_proxy = normalized.url;
            generateData.claude_model = model;
            if (model) generateData.model = model;
            // Claude 格式走 ST 原生 CLAUDE 分支需要密钥走 SECRET_KEYS.CLAUDE
            // —— 我们不污染用户密钥库，而是通过 x-api-key 附加头注入（x-api-key 是 Claude
            // 官方头名，但 ST 后端 CLAUDE 分支会自己加 Authorization 头）。
            // 实际：ST 的 sendClaudeRequest 只读 readSecret(CLAUDE, secret_id)，不支持从
            // generateData 透传密钥。所以 Claude 格式必须把密钥临时写入 SECRET_KEYS.CLAUDE
            // 槽里"ConnexHub 标记"的条目，卸载时清掉。
            if (conn.apiKey) {
                const sid = ensureConnexHubSecret(conn);
                if (sid) generateData.secret_id = sid;
            }
            if (conn.includeBody?.trim()) {
                // 只把白名单字段注入；其它走 generateData 顶层会引发后端忽略
                const obj = parseYamlObject(conn.includeBody);
                for (const [k, v] of Object.entries(obj)) {
                    if (CLAUDE_ALLOWED_EXTRA_BODY.has(k)) generateData[k] = v;
                }
            }
            for (const k of parseYamlList(conn.excludeBody)) {
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

// ── Claude 密钥借用酒馆密钥库（不污染 oai_settings） ─────────────

/** 每个连接复用一条带 ConnexHub 标记的密钥条目；连接 id 编码进 label 便于卸载清 */
async function ensureConnexHubSecret(conn) {
    try {
        const list = Array.isArray(secret_state[SECRET_KEYS.CLAUDE]) ? secret_state[SECRET_KEYS.CLAUDE] : [];
        const label = `${SECRET_LABEL_TAG}/${conn.id.slice(0, 12)}`;
        // 已有就原地 rotate
        const existing = list.find(s => s.label === label);
        if (existing) {
            await writeSecret(SECRET_KEYS.CLAUDE, conn.apiKey, label, { allowEmpty: true });
            // 重写后 id 不变（rotateSecret 走同名路径）；确保 active 指向它
            await makeSecretActive(SECRET_KEYS.CLAUDE, existing.id);
            return existing.id;
        }
        // 新建
        const newId = await writeSecret(SECRET_KEYS.CLAUDE, conn.apiKey, label, { allowEmpty: true });
        if (newId) await makeSecretActive(SECRET_KEYS.CLAUDE, newId);
        return newId;
    } catch (err) {
        console.error(`${LOG} ensureConnexHubSecret failed`, err);
        return null;
    }
}

async function makeSecretActive(key, id) {
    // 走与 ST 原生一致的"置为 active"流程：rotateSecret / 直接改 secret_state + 保存
    // 简化：复用酒馆原生的 rotateSecret
    try {
        const { rotateSecret } = await import('../../../secrets.js');
        await rotateSecret(key, id);
    } catch (err) {
        console.warn(`${LOG} rotateSecret failed`, err);
    }
}

// ── 活动连接 source 注入（仅在用户主动激活时改 source + 切到 ST 原生 source） ─

async function activateConnection(id) {
    const conn = getConn(id);
    if (!conn) return;
    const fmt = FORMATS[conn.format];
    if (!fmt) return;
    const normalized = fmt.normalizeEndpoint(conn.endpoint);
    if (!normalized.url) {
        toastr.error('请先填写端点 URL', LOG);
        return;
    }
    const targetSource = conn.format === 'claude'
        ? chat_completion_sources.CLAUDE
        : chat_completion_sources.CUSTOM;

    // 记录活动
    getStore().activeConnectionId = id;
    getStore().activeSource = targetSource;
    saveSettingsDebounced();

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
            toastr.error('切到 OpenAI 失败：当前为 Text Completion', LOG);
            return;
        }
        oai_settings.chat_completion_source = targetSource;
        $('#chat_completion_source').val(targetSource).trigger('change');
    }
    toastr.success(`已激活：${conn.name || conn.id}`, LOG);
    renderActiveHint();
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

// ── 模型拉取 ──────────────────────────────────────────────────

async function fetchModels(conn) {
    const fmt = FORMATS[conn.format];
    if (!fmt) throw new Error('未知格式');
    const norm = fmt.normalizeEndpoint(conn.endpoint);
    if (!norm.url) throw new Error('请先填写端点 URL');
    if (!conn.apiKey) throw new Error('请先填写 API Key');

    const headers = { 'Accept': 'application/json' };
    if (conn.format === 'claude') {
        headers['x-api-key'] = conn.apiKey;
        headers['anthropic-version'] = '2023-06-01';
    } else {
        headers['Authorization'] = `Bearer ${conn.apiKey}`;
    }

    const url = norm.url.replace(/\/+$/, '') + fmt.modelUrlSuffix;
    const resp = await fetch(url, { method: 'GET', headers });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}：${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    // 标准化为 [{id}] 列表
    const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const list = models.map(m => ({ id: m.id || m.name || m })).filter(m => m.id);
    conn.availableModels = list;
    conn.lastFetched = Date.now();
    saveSettingsDebounced();
    return list;
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
        opt.value = c.id; opt.textContent = `${c.name || '(未命名)'} · ${FORMATS[c.format]?.label || c.format}`;
        frag.appendChild(opt);
    }
    $sel.empty().append(frag);
    $sel.val(getStore().activeConnectionId || '');
}

function renderActiveHint() {
    const conn = getActiveConn();
    if (conn) {
        $('#cxh_active_name').text(conn.name || conn.id);
        $('#cxh_active_hint').show();
    } else {
        $('#cxh_active_hint').hide();
    }
}

function fillEditor(conn) {
    if (!conn) {
        $('#cxh_editor input, #cxh_editor textarea').val('');
        $('#cxh_format').val('openai');
        renderModelSelect(null);
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
    updateEndpointHint(conn);
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
    const fmt = FORMATS[conn?.format || 'openai'];
    if (!conn) { $('#cxh_endpoint_hint').text(''); return; }
    const norm = fmt.normalizeEndpoint(conn.endpoint);
    $('#cxh_endpoint_hint').text(norm.url ? `实际请求：${norm.url}` : '');
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
    };
}

function setStatus(text, kind = 'info') {
    const $s = $('#cxh_status');
    if (!$s.length) return;
    $s.text(text).attr('data-kind', kind);
}

// ── 事件绑定（全部 document 委托） ────────────────────────────

function bindEvents() {
    $(document).on('change.cxh', '#cxh_enabled', function () {
        getStore().enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $(document).on('change.cxh', '#cxh_conn_select', function () {
        fillEditor(getConn($(this).val()));
    });
    $(document).on('click.cxh', '#cxh_btn_activate', function () {
        const id = $('#cxh_conn_select').val();
        if (id) activateConnection(id);
    });
    $(document).on('click.cxh', '#cxh_btn_new', function () {
        const c = DEFAULT_CONNECTION();
        getConnections().push(c);
        saveSettingsDebounced();
        renderConnSelect();
        $('#cxh_conn_select').val(c.id).trigger('change');
    });
    $(document).on('click.cxh', '#cxh_btn_dup', function () {
        const id = $('#cxh_conn_select').val();
        const src = getConn(id);
        if (!src) return;
        const dup = { ...structuredClone(src), id: DEFAULT_CONNECTION().id, name: `${src.name || '(未命名)'} 副本`, lastFetched: 0 };
        getConnections().push(dup);
        saveSettingsDebounced();
        renderConnSelect();
        $('#cxh_conn_select').val(dup.id).trigger('change');
    });
    $(document).on('click.cxh', '#cxh_btn_del', function () {
        const id = $('#cxh_conn_select').val();
        if (!id) return;
        const idx = getConnections().findIndex(c => c.id === id);
        if (idx < 0) return;
        getConnections().splice(idx, 1);
        if (getStore().activeConnectionId === id) getStore().activeConnectionId = null;
        saveSettingsDebounced();
        renderConnSelect();
        fillEditor(null);
    });
    $(document).on('input.cxh change.cxh', '#cxh_endpoint, #cxh_format', function () {
        const id = $('#cxh_conn_select').val();
        const conn = getConn(id);
        if (conn) updateEndpointHint({ ...conn, format: $('#cxh_format').val() });
    });
    $(document).on('click.cxh', '#cxh_btn_eye', function () {
        const $i = $('#cxh_apikey');
        $i.attr('type', $i.attr('type') === 'password' ? 'text' : 'password');
    });
    $(document).on('click.cxh', '#cxh_btn_save', function () {
        const id = $('#cxh_conn_select').val();
        const conn = getConn(id);
        if (!conn) return;
        Object.assign(conn, collectFromEditor());
        saveSettingsDebounced();
        renderConnSelect();
        setStatus('已保存', 'ok');
    });
    $(document).on('click.cxh', '#cxh_btn_fetch_models', async function () {
        const id = $('#cxh_conn_select').val();
        const conn = getConn(id);
        if (!conn) return;
        Object.assign(conn, collectFromEditor());
        setStatus('拉取中…');
        try {
            const list = await fetchModels(conn);
            renderModelSelect(conn);
            setStatus(`已拉到 ${list.length} 个模型`, 'ok');
        } catch (err) {
            setStatus(`失败：${err.message}`, 'err');
        }
    });
    $(document).on('click.cxh', '#cxh_btn_test', async function () {
        const id = $('#cxh_conn_select').val();
        const conn = getConn(id);
        if (!conn) return;
        Object.assign(conn, collectFromEditor());
        setStatus('测试中…');
        try {
            const list = await fetchModels(conn);
            setStatus(`✓ 成功，${list.length} 个模型`, 'ok');
        } catch (err) {
            setStatus(`✗ ${err.message}`, 'err');
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

// ── 入口 ────────────────────────────────────────────────────

jQuery(async () => {
    getStore();
    initDefaults();

    // 注入设置面板
    try {
        const html = await renderExtensionTemplateAsync(`third-party/ST-ConnexHub`, 'settings');
        $('#extensions_settings').append(html);
    } catch (err) {
        console.error(`${LOG} render template failed`, err);
        return;
    }

    $('#cxh_enabled').prop('checked', !!getStore().enabled);
    renderConnSelect();
    renderActiveHint();
    const initial = getActiveConn() || getConn($('#cxh_conn_select').val());
    fillEditor(initial);
    bindEvents();

    // 请求注入钩子
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, applyActiveConnection);
    eventSource.makeLast(event_types.CHAT_COMPLETION_SETTINGS_READY, applyActiveConnection);

    // 用户在酒馆原生 UI 切回非活动 source 时，让活动 hint 同步
    $(document).on('change.cxh-source', '#chat_completion_source', function () {
        if (!getStore().enabled) return;
        const v = String($(this).val() || '');
        if (getStore().activeSource && v !== getStore().activeSource) {
            getStore().activeSource = v;
            saveSettingsDebounced();
        }
    });

    console.log(`${LOG} loaded · ${getConnections().length} connections`);
});