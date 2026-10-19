# @local/agent-hud

把 bilibili 视频 BV1LEWA6cErt（Agent HUD 简约形态，jazzenchen/agent-hud-open）的核心交互移植成 DSH 插件。

悬浮条贴在 **DSH 浏览器窗口**边缘（插件能力边界，盖不到操作系统桌面），可拖到上下左右四边，位置记在 localStorage。默认为两块（全称显示）+ 一个铃铛：

| 项 | 显示 | 圆环语义 | 点开 |
|---|---|---|---|
| **DeepSeek Harness** | 24h token（如 `147.2M`） | 24h tokens ÷ 自设预算，<70% 绿 / 70–90% 黄 / ≥90% 红 | 预算条、速率、前24h、调用、会话、输入/输出、缓存读取、24h 小时柱 |
| **DeepSeek** | 余额（如 `¥42.10`） | 低于预警金额时红环（面板里可开关、可改金额，人民币），否则绿环 | 各钱包、自动刷新开关/秒数、低余额预警开关/金额、立即刷新、更新时间、错误/暂用上次数据提示 |
| 铃铛 | 待办数 | — | 除当前会话外的其他 DSH 会话：待批准（同意/不同意）、待处理（打开）、运行中、有回复 |

- 审批答复与会话内卡片共享同一个 `PendingApproval`，先答的生效、另一边自动消失；Host 不碰审批流
- 圆环颜色全部走主题 `--dsw-alias-*` token，明暗自适应

## 数据来源

| 块 | 来源 |
|---|---|
| DeepSeek Harness | `~/.dsh/sessions/**/session.v4.jsonl.zstd`（多帧 zstd，自带 RFC8878 帧遍历器；按 `(size, mtime)` 增量缓存，只重解析变化的文件） |
| DeepSeek 余额 | `ctx.credentials.resolve('DEEPSEEK_API_KEY')` → `GET https://api.deepseek.com/user/balance`（只读，客户端按"自动刷新 + 秒数"触发，宿主 15s 硬下限 + 单飞 + 上次值兜底） |

## 刷新节奏

- **DeepSeek Harness**：客户端每 2 秒拉一次（页面隐藏时暂停，切回立即补一次）；宿主按文件增量缓存，只重算变化的会话
- **DeepSeek 余额**：默认每 90 秒自动刷新（面板内可开关、可改秒数），面板底部还有"立即刷新"按钮
- 打开的面板可以多个并存，从悬浮条左边缘向右依次排开；点 × 或再点一次芯片关闭

## 配置（cordis.patch.yml 的 config 层）

`refreshMs` / `balanceMinIntervalMs` / `dshBudgetTokens24h` / `labelHarness` / `labelBalance` / `dshHome`

低余额预警的开关与金额、余额自动刷新间隔都在余额面板里设置（存 localStorage，不占 config）。

## 安装

由 DSH 会话里的 plugin_manager `install_bundle` 安装（目标传本目录绝对路径），或
`dsh plugin --profile web add link:<本目录绝对路径>`。

## 已知边界

- Host 半改动需要宿主重启才生效（替换已加载模块的固有约束）；Client 半是静态文件，刷新即新
- 没有 `DEEPSEEK_API_KEY` 时余额块显示 `—`，面板里给出原因，其余功能不受影响
- 采集器按 `agents[]` 数组模块化，后续加 9router/其它服务商只需扩 `collect()`
- HUD 不拦截外部 agent 的审批；答复只覆盖 DSH 自身会话

## 许可

[MIT](LICENSE)。

交互形态参考了 [jazzenchen/agent-hud-open](https://github.com/jazzenchen/agent-hud-open)（Apache-2.0，macOS 原生版）
与 bilibili 视频 BV1LEWA6cErt；本插件为独立的 DSH 实现，未复制其源码。
