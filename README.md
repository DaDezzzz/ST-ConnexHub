# ConnexHub

SillyTavern 第三方扩展，**完全独立的数据与零 core 侵入**：

- 独立存储 API 端点 / 密钥 / 模型 / 附加参数 / 排除参数 / 附加请求头，按**每个连接**保存
- 双格式支持：**OpenAI 兼容** (`/chat/completions`) 与 **Claude / Anthropic** (`/messages`)
- 复用 SillyTavern 原生 CUSTOM / CLAUDE 路由（不重写请求体组装；与上游 tool calling / reasoning / json_schema 处理 100% 一致）
- 卸载可彻底清空自有数据 + 临时借用的密钥条目，不留残留

## 安装

通过酒馆扩展管理器：
```
https://github.com/<your-name>/ST-ConnexHub
```

或手动：
```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/<your-name>/ST-ConnexHub
```

## 使用

1. 打开「扩展设置」面板中的 **ConnexHub**
2. 新建连接 → 选格式（OpenAI 兼容 / Claude）→ 填端点 + API Key
3. （可选）点击「拉取模型」获取模型列表，或直接手动输入
4. 点击「激活」→ 酒馆原生 source 自动切到对应格式
5. 后续所有该格式请求走该连接；参数与请求头随连接自动应用

## 输出中断诊断（v1.2.1）

1. 在扩展管理器更新 ConnexHub，刷新酒馆页面。
2. 打开顶部插头 → **ConnexHub → 连接诊断（输出中断排查）**。
3. 勾选 **记录请求 / 响应摘要并保存到本机**。首次默认关闭；开关只在这个浏览器、这个酒馆地址记住。打开后才记录，之前的中断无法补录。
4. 用原来的连接正常聊天。出现中断、长时间无输出或报错后，点 **导出日志**，得到 `connexhub-diagnostics-*.json`。建议尽快导出，避免被后续记录挤出。
5. 排查完关闭记录并点 **清空日志**。不要为了测试修改密钥或重复发送大量请求。

### 保存与隐私

- 发起时保存请求摘要；收到响应头、结束或出错时保存接收摘要。收流期间由实际读取触发，最多每 5 秒保存一次进度，不轮询或额外发送网络请求。
- 记录模型、端点（去掉查询参数及 URL 凭据）、白名单参数、消息数、HTTP 状态、耗时、字节/块数、最长收包间隔、token 用量、结束原因、结束标志和脱敏异常。
- 不主动保留消息正文、回复正文、思考内容、原始 SSE 或认证请求头。上游错误可能夹带任意私密片段，脱敏不是绝对保证，**分享导出文件前请检查**。
- 本机 `localStorage` 独立键保存最近最多 30 条摘要，并限制归档大小；读取/保存时淘汰超过 7 天的记录。无痕模式、清理浏览器数据或更换浏览器/酒馆地址后可能无法恢复。同站点的其他脚本也能访问，勿在共用设备长期保留。
- 开关和日志不写入酒馆账户配置，不上传云端。存储被禁用/写满时退回当前页面内存，面板会提示，请关闭页面前导出。
- 尽量只用一个标签页复现；多标签页合并为尽力而为，不保证并发写入不丢记录。页面重载留下的进行中快照标为「上次记录未完成」，**不是直接认定网络中断**。

### 如何理解记录

| 标记 | 含义与边界 |
| --- | --- |
| `completed` | 已观察到 `[DONE]` / `message_stop`，或完整非流式聊天响应，不保证内容质量和业务完整性 |
| `finishReasons: length / max_tokens` | 模型或网关报告达到输出限制，需结合用量判断 |
| `eof_without_end_marker` | 读取结束但缺少协议终止标志，可能是提前断流或网关实现差异 |
| `malformed_sse` | SSE 中有无效 JSON；即使随后出现结束标志，也不能视为正常解析完成 |
| `api_error / http_error / stream_error` | 接口显式错误 / HTTP 错误 / 响应读取失败 |
| `aborted / consumer_cancelled` | 调用方取消或读取消；可能是手动停止，也可能是前端异常处理，不直接归咎于上游 |
| `incomplete_snapshot` | 上次记录过程没有观察到结束，需继续取证 |

### 观测边界

记录的是 **浏览器 ↔ SillyTavern**，看不到酒馆后端组装后的最终提供方请求体，也看不到提供方内部情况。只观测匹配当前 ConnexHub 连接的生成请求，不记录模型列表请求。

开启后会在原 `fetch` 响应流外增加一层按需透传观测，保持原请求参数和取消信号，不重试、不主动取消、不并行克隆整条流。关闭时新请求走原链路；已在读取的流继续透传、不被打断。仍可能与其他封装 `fetch` 的扩展存在兼容差异，若只在开启诊断时异常，应关闭开关做对照。

请求期间捕获的全局浏览器异常仅表示时间关联，不保证来自本请求；被酒馆内部捕获的错误未必会上报。超大响应/事件超过解析缓冲上限时跳过其内容并记警告，不能保证提取到其结束字段。`Streaming request finished` 单独一行也不能证明模型完整输出。

开发者离线验证（不需要真实 API Key）：

```sh
node --test tests/*.test.mjs
```

## 卸载

扩展管理 → ConnexHub → 勾选「Also clean up extension data」→ 删除。  
`cleanupPluginData` hook 会清空：
- `extension_settings.connexHub` 全部数据
- 酒馆密钥库 `SECRET_KEYS.CLAUDE` 槽中所有 `ConnexHub/...` 标记的条目

## 数据隔离保证

| 数据 | 存储位置 | 是否影响原生气 |
|------|----------|----------------|
| API 端点 / Key / 模型 | `extension_settings.connexHub.connections[*]` 自有命名空间 | ❌ 不写 oai_settings |
| OpenAI 格式密钥 | 注入到 `custom_include_headers.Authorization`（不存酒馆密钥库） | ❌ |
| Claude 格式密钥 | 临时写入 `SECRET_KEYS.CLAUDE` 槽的 `ConnexHub/...` 标记条目，卸载时删 | ❌ 卸载时全清 |
| 附加体 / 排除 / 附加头 | 连接对象 | ❌ |
| 原生 `oai_settings` | **不写** | — |

## 路线

- [x] 独立数据结构
- [x] 双格式支持
- [x] 模型拉取
- [x] 首次安装初始化两种格式示例
- [x] 卸载清理 hook
- [ ] 导入 / 导出