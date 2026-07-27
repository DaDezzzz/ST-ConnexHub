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
- [ ] 预设联动（API Hub 模式）