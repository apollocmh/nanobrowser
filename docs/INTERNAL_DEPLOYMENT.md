# 内部部署与后续迭代

## 选择安装包

| 产物 | 浏览器 | 聊天与审批 |
| --- | --- | --- |
| `internal-browser-assistant-0.3.0-mv2.zip` | 支持 MV2 的 Chromium 80–124；其他内核版本须单独验证 | 按目标标签页绑定的独立窗口 |
| `internal-browser-assistant-0.3.0-mv3.zip` | Chrome 125 及以后 | 原生侧栏 |

验证结果和已知限制以 [兼容报告](CHROMIUM80.md) 为准。Chromium 80 的原生 HTML5 拖放明确不支持；鼠标/指针排序、滑块和 canvas 拖动可用。新版支持真实原生拖放。MV2 不能规避现代 Chrome 对 MV2 的停用。

1. 解压对应 ZIP，保留完整目录；打开浏览器扩展管理页，开启开发者模式，选择“加载已解压的扩展程序”。不要同时加载两个包到同一测试会话。
2. 点击工具栏图标或配置扩展快捷键（默认 `Alt+Shift+N`）。MV2 聊天窗口属于打开它的目标标签页，重复点击会聚焦已有窗口；关闭目标页会关闭相应窗口。
3. 在设置中选择模型服务商和模型，也可配置 OpenAI 兼容的远程 HTTP(S) 端点。终端用户无需安装 Node、Python、本地服务、浏览器驱动或 CDP 代理。开发用的 fixtures 服务不随产品启动，也不是运行前提。
4. 默认 Ask 模式。写入操作通过聊天窗口审批；付款、授权、秘密输入等仍由用户完成。Stop 会停止当前任务并取消持有的鼠标手势。
5. 设置可关闭 AI 鼠标和页面边框。截图会暂时隐藏两种装饰。旧版完整截图可能临时改变视口，结果会说明恢复状态；页面对 resize 的脚本响应无法回滚。

生产包没有开发用自动运行入口的测试驱动消息能力；测试 fixture 的模型响应不能证明真实服务商连通。部署前应使用实际内部模型服务验证流式响应、工具调用、取消、附件及语音模型。

## 单一品牌配置

修改 [src/brand.ts](../src/brand.ts) 后重新构建，不需要改存储键。资源文件放在 `public/` 内，路径相对该目录。

| 配置 | 用途 |
| --- | --- |
| `name`、`description` | 安装名称、描述、窗口标题、通知、快捷键及三语言品牌文案 |
| `providerTitle` | 模型服务商所需的 ASCII 应用标题；不要填写中文 HTTP 请求头 |
| `icon`、`toolbarIcon`、`logo` | 安装图标、工具栏图标、界面 Logo；`logo` 留空使用中性标记 |
| `accent`、`accentStrong`、`sky` | 空格分隔的 RGB 数值；构建与主题层负责旧版颜色语法 |
| `website`、`help`、`privacy` | 内部站点、帮助、隐私链接；留空时隐藏对应入口 |
| `ratingEnabled`、`chromeStore`、`edgeStore` | 评分卡与目标商店；内部默认关闭 |
| `uninstallUrl` | 卸载问卷；内部默认空字符串，清除之前的卸载 URL |
| `analyticsEnabled` | 允许配置统计外发；默认 `false`，即使历史存储曾开启也不外发 |

统计需要构建配置开关、`.env.example` 中的统计目的地及用户设置共同允许。若重新开启统计或替换目的地，须同步更新 `PRIVACY.md`。上游许可证、版权、第三方依赖署名保留；历史记录里的上游身份和内部安全标记不会批量替换。

构建会统一生成 HTML 标题、Chrome `_locales` 消息和 manifest，不应手动编辑 `dist/` 或 `dist-mv2/`。原有 `nb.*` 存储键和旧版本迁移逻辑保持；不同扩展 ID 的本地数据不会自动共享。会话导出用于留档；当前产品不提供会话导入，不要把更换扩展 ID 当成数据迁移。

## 开发与验收

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm type-check
pnpm test
pnpm build:all
pnpm zip:mv2
pnpm zip
```

Node 24 和 `package.json` 固定的 pnpm 10.34.7 仅用于开发构建。若全局 pnpm 版本不同，使用 `corepack pnpm`。本机 SWC 缓存 ACL 的处理见兼容报告，不能关闭缓存安全检查。

```powershell
pnpm autorun 'compatibility,gestures,gesture-controls,virtual-mouse,companion-window' --mv2 --chrome 'D:\Software\Chrome\Chrome80\app\chrome.exe'
```

旧版自动使用有窗口浏览器和隔离临时用户目录。运行器只启动普通浏览器进程，所有 CDP 操作来自扩展自身的 `chrome.debugger`，没有外部调试端口。结果写入 `fixtures/.results/`，包含真实浏览器路径、UA、分阶段证据、图片和失败信息。运行器不会删除真实用户 profile。

Windows 的 `.cmd` 对 JSON 参数存在引号差异，可使用 `--args-file`：

```powershell
Set-Content -LiteralPath 'fixtures/.results/zoom.json' -Value '{"zoom":1.25}' -Encoding utf8
pnpm autorun 'compatibility,compatibility-diagnostics' --mv2 --args-file 'fixtures/.results/zoom.json' --chrome 'D:\Software\Chrome\Chrome80\app\chrome.exe'
```

后续功能迭代须保持浏览器控制层的身份、安全、派发后不重试及三类结果语义；Agent、品牌与 UI 继续通过现有边界接入。每次涉及控制、截图或运行时依赖的变更，都应在旧版实机和新版包重跑覆盖该行为的检查。`partial`、`unsupported`、超时及未执行的检查不得登记为兼容通过。
