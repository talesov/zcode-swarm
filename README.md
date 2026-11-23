# zcode-swarm

> 当前版本 **0.4.3**，架构标签 **v2.0 独立编排**（脱离工作流引擎，主会话直接编排 Agent）。

独立编排的团队开发插件：一个需求 → 拆成互不重叠的任务卡 → 并行 Agent 施工 → 逐卡独立审查 → 按需返工 → 整体验证 → 你收报告。不依赖工作流引擎。

## 安装

本仓库是"仓库即市场"结构，`marketplace.json` 在根目录。总体架构、路线图与纪律见 [docs/ROADMAP.md](docs/ROADMAP.md)。

1. ZCode → **Settings → Plugin Management** → **Discover** 标签页
2. 点 **`+`** 添加市场，选 **local directory**，指向本目录
3. 找到 `zcode-swarm`，安装并启用
4. 重载会话（SessionStart 钩子会检查未完成的团队运行，并按需重渲染已保存工作流 `ensure`）

## 用法

```
/swarm <需求描述 | resume | abandon> [gate: 验证命令]
```

示例：

```
/swarm 顾客到场节奏、火候结算、店铺升级经济三个模块各自重构并补测试，gate: npm test
/swarm 给结算页补单元测试，同时把取数逻辑抽成独立模块，gate: npm test
/swarm resume                                      ← 恢复上次未完成的团队运行（按 .swarm/ledger.json 续跑）
/swarm abandon                                     ← 放弃未完成的运行并归档台账
```

模型在 **ZCode 设置 → 子智能体 → ZCode Swarm** 里按角色设置，插件不配置模型（详见下方[「模型」](#模型)）。

流程：拆单（任务卡：任务/写入范围/验收判据/角色）→ 并行施工 → 逐卡独立审查 → 按意见返工（上限可设）→ gate 验证命令 → 施工报告。全程看板围观，有升级提问才出手。断点续跑靠 `.swarm/ledger.json`：中途断掉就说 `/swarm resume`，不想继续就说 `/swarm abandon`。

### 团队看板面板（侧栏常驻，实时刷新，0.4.2）

进度有两种呈现，**同源**（都从 `.swarm/ledger.json` 渲染）：

- **聊天卡片**：开工、每次状态变化、出报告时由 `render board` / `render report` 生成，留在对话流里；
- **侧栏面板**：插件注册的常驻侧栏面板「团队看板」（layout-dashboard 图标，与 Documents/PDF 等官方面板同一套 UI Surface 机制）。面板不直接读台账：它订阅 `swarm-board` 服务提供的看板数据资源（`ui://zcode-swarm/board.json`），服务端 `fs.watch` 台账一变就推送，面板另带 5 秒兜底轮询（直读模式 2.5 秒），不用手动刷新，也不会随聊天滚动消失。

打开方式两种：① 直接点侧栏的「团队看板」图标；② 开工时主会话调用一次 `swarm_board` 工具（zcode-swarm 插件提供的 MCP 工具，无参数、只读；工具带 `ui` 元信息，宿主可据此把对应面板切到前台，同时把同一份看板数据回给主会话）——init 完台账、`resume` 恢复时都会调一次。之后面板自己跟随台账刷新，无需重复调用。面板是增量，聊天卡片保留不变，两边看到的是同一份数据。

## 架构

- 编排：主会话直接控制（技能文件协议），无工作流引擎、无启动步骤——发 `/swarm` 即开工
- Worker：Agent 工具 + agent 定义文件（工具/纪律）
- 状态：`.swarm/ledger.json` 任务台账（唯一事实源）
- 看板：聊天 Gen UI 卡片（templates/board-card.html）+ 侧栏常驻面板「团队看板」（0.4.2 起，插件 UI Surface；0.4.3 起 `swarm_board` 只唤起面板并返回运行概要，完整数据走 `resources/read`，避免宿主把工具结果渲染成第二份看板）
- 恢复：SessionStart 钩子读台账提示 `/swarm resume`；同一钩子跑 `swarm-config.mjs ensure`，按「当前模板 + 当前设置」应有的渲染结果做内容比对，不一致才重渲染（幂等，v2 开工不经过它）
- 触发：SessionStart 恢复；定时巡检/CronCreate 看门狗**规划中**（见 [ROADMAP M4](docs/ROADMAP.md)）
- 模型：由宿主「子智能体」设置决定（ZCode 设置 → 子智能体 → ZCode Swarm），插件不配置模型（见下方[「模型」](#模型)）

## 与 v1（工作流引擎版）的区别

| | v1（引擎） | v2（独立） |
|---|---|---|
| 编排 | 工作流脚本（TypeScript） | 技能文件协议（Markdown） |
| Worker 创建 | agent(name, {model}) | Agent 工具 + agent .md |
| 模型约束 | 编译期字面量 | 插件不配置模型：每个角色的模型由宿主「子智能体」设置决定（没设＝继承默认，跟随主会话）；`show` 可查实际生效值 |
| 确认窗 | 每次启动弹窗 | 无（Agent 工具不弹） |
| 断点续跑 | 引擎 journal | .swarm/ledger.json |
| 看板 | artifact.board() | 聊天 Gen UI 卡片 + 侧栏常驻面板「团队看板」（0.4.2） |
| 两层限制 | 受限（worker 不能再 spawn） | 恒两层：施工员/审查员/修复员的工具集里没有 Agent，造人只发生在主会话 |

## 组件

| 组件 | 形态 | 作用 |
|---|---|---|
| /swarm 命令 | 斜杠命令 | 入口（含 `resume` / `abandon` 分支） |
| swarm-architect | Agent 定义 | 架构设计（可选） |
| swarm-planner | Agent 定义 | 拆单规划（只读） |
| swarm-builder | Agent 定义 | 施工员 |
| swarm-reviewer | Agent 定义 | 独立审查员 |
| swarm-fixer | Agent 定义 | 集成修复员 |
| swarm-config.mjs | Node CLI | 角色模型查询（show）/ 返工轮数设置（set、reset）/ 任务卡校验（check-cards、validate）/ 已保存工作流渲染与 ensure |
| swarm-ledger.mjs | Node CLI | 任务台账（init / status / update / artifact / next / spawn / bounce / finding / gate / fixer / finish / board / report / render / recover） |
| board-card.html | HTML 模板 | 聊天流实时看板卡片 |
| 团队看板面板 | 插件 UI Surface + MCP server | 侧栏常驻看板（0.4.2）：`ui/panel.html` 面板 + `scripts/swarm-board-server.mjs`（stdio MCP，`swarm_board` 无参数工具、`ui://…/board.json` 资源、fs.watch 推送），三级降级取数（MCP 桥订阅 → `ui://` 直读轮询 → 静态快照+手动刷新） |
| report-card.html | HTML 模板 | 最终报告 |

## 模型

模型 100% 由宿主决定，**插件不配置模型**：在 ZCode **设置 → 子智能体 → ZCode Swarm** 里，可以给 5 个角色分别指定模型——**planner（拆单）、architect（架构设计）、builder（施工）、reviewer（审查）、fixer（集成修复）**。没有单独指定的角色＝「继承默认」，跟随主会话模型。

查每个角色实际用什么：

```bash
node scripts/swarm-config.mjs show          # 5 个角色的模型与来源（宿主设置 / 继承默认），以及返工轮数
node scripts/swarm-config.mjs show --json   # 机器可读：roles 数组（role/model/source）+ settings
```

主会话开跑前用 `show --json` 读这份结果，写进台账的 `agent_models`（`resolved: [{role, model, source}]`），报告卡的「团队角色模型」表就来自它。派工时不需要、也无法在 Agent 工具里指定模型——宿主 per-agent 设置优先。

插件侧只剩一个运行时参数——返工轮数：ZCode 设置 → 插件配置的 `reworkRounds`（0-5，默认 2，脚本**只读不写**；只有项目没有自己的设置时才生效）；要按项目定，用 `node scripts/swarm-config.mjs set --json '{"rework_rounds": 2}'` 存到当前项目（`reset` 恢复默认 2）。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 侧栏「团队看板」面板一片空白 | 本项目还没有运行台账（`.swarm/ledger.json` 不存在）——这是**正常空态**，不是故障。发起一次 `/swarm` 后台账建立，面板自动填上内容。已有台账但面板仍空白，多半是打开时面板服务还没连上（面板退到静态快照，并在页面上挂警告条）：点右下角「手动刷新」（重连并重新订阅），或重启会话让主会话再调一次 `swarm_board`；断线期间面板每 30 秒会自己静默重探测一次 |
| 面板没跟上最新状态 | 面板靠服务端 fs.watch 推送 + 5 秒兜底轮询刷新（直读模式 2.5 秒），正常秒级内跟上；确认主会话确实把状态写进了 `.swarm/ledger.json`（`node scripts/swarm-ledger.mjs status`），没写台账就没有东西可刷 |
| 找不到面板入口 | 插件未启用或未重载：Settings → Plugin Management 确认 zcode-swarm 已启用，然后重载会话；重载后侧栏图标即出现，也可以让主会话调一次 `swarm_board` 唤起 |
| 面板显示「面板文件缺失」或「看板数据读取失败」 | 前者是部署不完整（服务端读不到 `ui/panel.html`，返回内置降级页）；后者是取数失败——面板保留上一帧并在顶部挂警告条，重连成功后自动消失。重装/重部署插件后重开面板；`.swarm/ledger.json` 不存在或不是合法 JSON 时服务端按空态/无台账返回，不会报错 |

## 零依赖，Node 18+

脚本不联网、不碰 API key；设置只写 `~/.zcode/zcode-swarm/settings.json`（或你显式保存的项目 `.swarm.json`），宿主 `userConfig`（`~/.zcode/cli/config.json` 的 `plugins.options`，现在只剩 `reworkRounds`）**只读不写**——宿主层只影响 global default 作用域的输出，任何命令都不会把它的值写进设置文件。
