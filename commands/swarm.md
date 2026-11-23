---
description: 发布一个团队开发需求：说完需求即开工——主会话直接编排并行 Agent，全程只在最后收报告
argument-hint: <需求描述 | resume | abandon> [gate: 验证命令]
---

# 团队开发（主会话编排直达模式）

把 `$ARGUMENTS` 变成一次团队开发运行。**主会话自己当编排者**：拆单 → 并行 spawn 后台施工员 → 收完成通知 → 独立审查 → 按意见返工 → 动态扩编 → gate 验证 → 修复 → 报告。默认零中途确认：需求说清即开工，你只等最终报告；仅当需求本身有歧义时才追问。运行状态全部记在台账 `.swarm/ledger.json`（由 swarm-ledger.mjs 管理）——**唯一事实源，每变一步先写台账再走下一步**。

## 0. 准备（秒级）

**入口分流（先判 `$ARGUMENTS`；正常需求文本不进这两个分支）**。这两个分支里的台账命令要先把下面「定位脚本」块跑一遍，设好 `$CFG` / `$LEDGER`。

- **`resume`** → 恢复未完成的运行：先读台账 `.swarm/ledger.json`（或 `node "$LEDGER" status` 看摘要）；没有台账或状态不是 running 就直说没有可恢复的运行。然后按台账状态恢复编排：`pending` 卡照第 3 步派工；`working` 卡的**原后台任务已随会话结束，需重新 spawn 该卡施工员**（台账已是 working，不必再写状态）；`reviewing` 卡从台账取出该卡的 `result`（或 `node "$LEDGER" artifact card-<id>-result.json` 读归档）后照第 4 步派审查员；`rework` 卡照第 4 步第 5 点重新 spawn 施工员后再写 `{"state":"working"}`（两步里的第二步，第一步 `reviewing → rework` 已完成，轮次已记）；台账里 `gate` 已有结论（`gate_status` 非空）而运行仍 running → **不再**重跑 gate：`pass` 就 `finish completed`，`fail` 按第 5 步修复流程继续或 `finish failed`，然后走第 6 步出报告。恢复完 `node "$LEDGER" render board` 刷新看板，`::visualize` 行放进回复；会话重启后侧栏面板多半已关闭，从左侧栏图标重新打开即可，之后它自动跟随台账刷新。
- **`abandon`** → 放弃本次运行：`node "$LEDGER" finish failed`。若 finish 因状态拒绝（台账已不在 running），先按台账把在途卡 `update <卡id>` 置 `failed`：`pending` / `working` / `reviewing` 可一步写 `{"state":"failed"}`；`rework` 卡状态机不允许直接到 failed，需先 `{"state":"working"}` 再 `{"state":"failed"}`。全部落定后重新 `finish failed`；随后 `node "$LEDGER" report` 出报告并归档（report 会把 report.md 落到 `.swarm/artifacts/<run_id>/`），台账保留备查。

**定位脚本**：

```bash
CFG=$(find ~/.zcode/cli/plugins/cache -name swarm-config.mjs 2>/dev/null | sort -V | tail -1)
[ -n "$CFG" ] || CFG=$(find ~/.zcode/cli/plugins -name swarm-config.mjs 2>/dev/null | sort -V | tail -1)
LEDGER=$(find ~/.zcode/cli/plugins/cache -name swarm-ledger.mjs 2>/dev/null | sort -V | tail -1)
[ -n "$LEDGER" ] || LEDGER=$(find ~/.zcode/cli/plugins -name swarm-ledger.mjs 2>/dev/null | sort -V | tail -1)
node "$CFG" show --json
```

两个脚本任一找不到就直说插件没装好。`node "$CFG" show --json` 打印 5 个角色（planner / architect / builder / reviewer / fixer）的实际模型与来源（`roles` 数组，`role` / `model` / `source`；source 为「宿主设置」或「继承默认」）以及 `settings.rework_rounds`。**插件不配置模型**：角色模型由 ZCode 设置 → 子智能体 → ZCode Swarm 决定，没设的角色跟随主会话模型；这里只读取，不指定、不修改。把 `roles` 数组和 `rework_rounds` 留到第 2 步写进台账。

## 1. 快速粗拆（目标：几分钟内出卡，宁粗勿慢）

按 swarm 技能文件里的「拆单纪律」拆（只读取证、边界有据、互不重叠、数量诚实、宁粗勿慢）。两种拆法：

- **主会话自己拆**——默认走这条，小需求直接拆更快
- **spawn swarm-planner 后台代理拆**——需求大、卡多时再派

**粗卡**即可：边界明显的直接定 scope，拿不准的不用深挖代码取证——施工员途中发现漏掉的相关工作会经扩编补位。取证上限 ≤6 个文件，或只读用户点名的那份规划文档。每张卡写清角色（builder / reviewer 等）即可，**不要给卡指定模型**（模型由宿主按角色决定）；gate 用项目现成的测试/构建命令（package.json / Makefile / CI 里找），没有就空着并说明。

- 需求有实质歧义（做哪个版本、改哪个系统）→ 问一句再拆
- 需求指向**未指明的待办**（"待做的内容 / TODO / 继续完成 / 自己看着办"而没点名模块或文件）→ 先问用户要具体清单，或只读用户点名的一份规划文档；**不要全库搜索猜"要做什么"**——这是启动前长等待的主要来源
- 拆不出 ≥2 张卡 → 直说"这不是 swarm"，用单个 Agent 完成，不要硬凑

需求里点名了模型（"这次用 X / UI 那张用 X / 审查用 X"）→ 告诉用户该角色必须在 **ZCode 设置 → 子智能体 → ZCode Swarm** 里改（插件不配置模型，Agent 工具也没有按次指定模型的参数）；用户改完后重跑 `node "$CFG" show --json`，让台账里的 `agent_models` 反映实际生效值。不要改 agent 定义文件的 `modelSelection`。

## 2. 校验 + 初始化台账（不问你，直接过）

```bash
node "$CFG" validate --stdin <<'JSON'
{ "cards": [ ... ] }
JSON
node "$LEDGER" init --stdin <<'JSON'
{
  "requirement": "<需求原文>",
  "cards": [ ... ],
  "gate": "<验证命令或空串>",
  "agent_models": {
    "resolved": [
      { "role": "planner",   "model": "<show --json 的 roles[].model>", "source": "宿主设置|继承默认" },
      { "role": "architect", "model": "...", "source": "..." },
      { "role": "builder",   "model": "...", "source": "..." },
      { "role": "reviewer",  "model": "...", "source": "..." },
      { "role": "fixer",     "model": "...", "source": "..." }
    ]
  },
  "rework_rounds": 2
}
JSON
```

validate 退出码 2 就按提示改到通过为止，**不要绕过**；它只校任务卡（必填字段、写入范围不重叠），输出 `{ cards, workflow }`，没有模型项。validate 成功时还会顺手 `ensure` 一次已保存工作流（按「当前模板 + 当前设置」应有的渲染结果做内容比对，不一致才重写；v2 开工不读它，只是让部署产物不与脚本漂移）。

init 的必填字段是 `requirement`、`cards[]`、`gate`（没有验证命令传空串，**字段不能省**）。另两个是可选运行元数据：`agent_models` 来自 `show --json` 的 `roles` 数组（每个角色的实际模型与来源，形状 `{ "resolved": [{ "role", "model", "source" }] }`，可带 `note`）；`rework_rounds` 是返工/修复轮上限（来自 `show --json` 的 `settings.rework_rounds`）。写进台账后，**报告卡**会自动带「团队角色模型」表，返工上限也按台账值执行。init 在 `.swarm/` 下建账并给每张卡分配台账 id——那份 id 清单就是第 3 步的派工清单。

**init 完成后立即展示看板（聊天卡片 + 常驻面板，两份表达并存）**：

```bash
node "$LEDGER" render board
```

脚本会自动取台账数据 → 注入看板模板 → 写入会话可视化目录 → stderr 输出一行 `::visualize{"path":...}`，你把那行原样放进回复正文单独一行。用户从此刻起就能看到团队任务看板卡片。

**侧栏「团队看板」面板从左侧栏图标打开**（插件注册的 UI Surface，图标 layout-dashboard、标题「团队看板」，与 Documents/PDF 等官方面板同一套机制）。`swarm_board` MCP 工具（无参数、只读）只返回一份运行概要（run_id/状态/阶段/进度/计数）——它刻意不带 UI 元信息，宿主不会把它渲染成聊天流里的第二份看板（0.4.3 修复：此前带 `_meta.ui` 会被宿主内嵌渲染成重复看板）。数据链路是「面板服务读 `.swarm/ledger.json` → 映射成看板数据 → 面板订阅这份数据」：面板本身从不直接读台账（写台账的仍是主会话），只走服务端推送 + 轮询；面板经 MCP 桥订阅 + 5 秒兜底轮询（宿主拦 `ui:` 协议时退到直读轮询 2.5 秒，再不行显示静态快照；断线期间每 30 秒静默重探测）。此后无需再调工具；聊天流里的看板卡片照常保留，两者同源并存——面板是增量，不替换卡片。本项目台账还没有运行时，面板显示空态（正常现象）。

## 2.5 架构师（可选，默认开）

卡数 ≥3 或需求涉及跨模块交互时，**在台账初始化并出看板之后** spawn 架构师出设计文档（`artifact` 命令要求台账已存在，所以不能先于第 2 步）：

- 用 Agent 工具 spawn，subagent_type: "swarm-architect"，run_in_background: true
- prompt 包含：需求原文 + 任务卡列表（JSON，带台账 id）
- **架构师完成通知到达后**，把设计文档写入台账产物目录：
  ```bash
  node "$LEDGER" artifact design.md --stdin <<'EOF'
  <设计文档内容>
  EOF
  ```
- 2 张简单卡、各自独立改动时，可跳过此步（省一轮 agent）
- 用户说"先出方案"时强制走此步

后续派工时，每张卡的 prompt 中附上设计文档中"各卡实现建议"章节里对应卡的建议。**架构师尚未返回而其他条件已就绪时不要干等**：先派无依赖的卡；架构师建议到达后补进对应卡的下一次 prompt（返工轮时一并带上），始终没返工的卡在报告里注明"建议未落地"。

产物统一归档在 `.swarm/artifacts/{run_id}/`：设计文档由 `artifact` 子命令落到该目录下的 `design.md`，随运行一起保留备查。

## 3. 并行派工（核心循环）

对台账里每张 pending 卡，用 **Agent 工具** spawn 后台施工员，一口气全派出去：

- `subagent_type`: `swarm-builder`（需要限定来源时写 `swarm-builder@zcode-swarm`）
- `prompt`: 任务卡全文（标题/范围/验收标准）+ **结果 JSON 格式要求** + **架构师建议：{设计文档中该卡的建议}**（走了 2.5 且已归档时；该卡无建议写"无"，设计文档还没归档写"架构师设计文档未返回，先按卡上要求做，返工时补建议"）。施工员收尾必须输出一个 JSON 代码块：
  ```json
  { "summary": "做了什么", "files": ["改动的文件"], "spawns": [ { "title": "...", "scope": "...", "reason": "为什么值得做" } ] }
  ```
  `spawns` 放途中发现的漏项（没有就空数组）；属于自己卡内的小尾巴直接顺手做掉，只把真正的新工作放进去。
- `run_in_background`: true
- 模型：**派工时不要指定模型**。Agent 工具没有按次指定模型的参数，角色实际用什么由宿主「子智能体」设置决定（ZCode 设置 → 子智能体 → ZCode Swarm，没设就是继承默认、跟随主会话）。不要改 `agents/*.md` 的 `modelSelection` 来"路由"模型——那只会误导人。台账 `agent_models` 里记着每个角色的实际模型与来源，报告里按它如实说明。

每 spawn 一个**立即**写台账（先写台账再派下一张）：

```bash
node "$LEDGER" update <卡id> --stdin <<'JSON'
{ "state": "working" }
JSON
```

全部派出后再跑一次 `node "$LEDGER" render board` 刷新看板（脚本自动生成新卡片文件，`::visualize` 行放进回复），然后报告已派出的卡（编号/任务/范围/角色 + 台账 `agent_models` 中的角色模型 + gate），明确告诉用户：可以走人了，完成通知会带回报告。

## 3.5 蜂群运行中收到用户消息（中途消息路由，先跑再回答）

**蜂群正在跑（台账 status=running）时，用户发的任何消息都必须先走 swarm 路由，不许直接自己处理**。

第一步（每次用户消息都跑）：
```bash
node "$LEDGER" route "<用户的原始消息>"
```
脚本输出当前每张卡的状态/范围/agent_id + 基于关键词匹配的路由建议。

按建议 + 你的判断路由：

| 用户消息类型 | 判定线索 | 动作 |
|---|---|---|
| 追加新工作 | 「也做/加上/顺便/再加」 | `spawn` 扩编新卡 → 派工 |
| 改在跑卡的事 | 消息内容匹配某张 working/reviewing/rework 卡的 scope 或标题 | `bounce` 追加指令到该卡（每卡 2 批上限） |
| 改已完成的事 | 消息匹配某张 passed 卡 | passed 卡不可改 → `spawn` 新卡 |
| 取消/不做 | 「取消/算了/不要/别做」 | 对应卡 `update` 写 `state: "failed"` + `error: "用户取消"`，或 `finish failed` |
| 暂停/停 | 「暂停/停下/先别」 | 等在飞卡收完再 `finish`；紧急时 `finish failed` |
| 与当前 run 无关 | 完全不同的话题 | 正常回答 + 告知「蜂群仍在跑，完成后会出报告」 |

路由完继续等蜂群通知。**绝不在有活跃蜂群时绕过 swarm 单独处理用户的开发需求。**

## 4. 收到通知后的处理循环（等通知 + 主动轮询兜底）

后台任务的完成通知会唤醒主会话；一次处理一条，全部按台账当前状态路由，**每个动作前后都以台账为准**。

**通知会丢，不能只等**。三条兜底规则：

1. **派工即落 agent-id**：每个施工员 spawn 出去后，立刻把它返回的 agent-id 写到对应卡上：
   ```bash
   node "$LEDGER" update <卡id> --stdin <<'JSON'
   { "agent_id": "<宿主返回的 agent-id>" }
   JSON
   ```
2. **30 分钟主动查（定时器驱动，不靠记性）**：第一次派工后立刻用主会话的 `CronCreate` 工具建一个约 30 分钟一次的定时提醒（参数按该工具 schema，目的是唤醒自己），运行 finish 时 `CronDelete` 删掉。被唤醒后跑一条命令拿全部事实：
   ```bash
   node "$LEDGER" watchdog          # 每张超时卡一行：[STALE]/[KILL] + agent_id + 建议动作
   ```
   对每条 `[STALE]`（≥30 分钟无通知）：按行内 agent_id 用主会话的 `TaskOutput` 主动查一次——状态已是 `completed` 就地收卡（从输出尾部解析交回 JSON，照下面第 1、2 条落账进审查），仍在 `running` 才继续等。
3. **90 分钟判死**：`watchdog` 输出 `[KILL]` 行（或 `TaskOutput` 查无进展）时，把该卡写 `state: "failed"`（`"error"` 注明死因，如 `insufficient_balance` / 停摆判死），报告如实披露；主会话可接管重做或等用户决断，不要让整次运行卡死在死掉的施工员上。

1. **施工员完成** → 读取输出，解析结果 JSON（没给 JSON 或任务异常退出 → 把错误信息当作返工意见：仍按第 2 条先写 `state: "reviewing"`（可带 `"error": "..."`），再走本循环第 5 条的 FAIL 返工）
2. **写台账**：
   ```bash
   node "$LEDGER" update <卡id> --stdin <<'JSON'
   { "result": { "summary": "...", "files": [...], "spawns": [...] }, "state": "reviewing" }
   JSON
   ```
3. **结果里有 `spawns` → 分诊**：
   - 值得做的新工作 → `node "$LEDGER" spawn <父卡id> --stdin` 追加进台账（父卡 id = 上报这条 spawns 的卡，用 `node "$LEDGER" status` 查；新卡字段格式同 init 的卡：title / task / scope / acceptance / role，不指定模型），然后照第 3 步派工（写 `working` + spawn）；
   - 属于某张在跑卡自身尾巴的 → 用 **bounce** 打回那张卡（不要手改台账、也不要拿 finding 代替）：
     ```bash
     node "$LEDGER" bounce <目标卡id> --stdin <<'JSON'
     { "text": "<追加指令全文>", "source_card_id": "<上报这条尾巴的卡id>" }
     JSON
     ```
     脚本把追加指令记到目标卡的 `bounces`（返工 prompt 从这里取；`source_card_id` 会先校验来源卡存在、再记进条目，`text` 也可写成 `title`/`summary`/`changes`），**每卡最多 2 批**；第 3 批及以后、或目标卡已到终态时脚本自动转 `deferred`（reason 分别为 `超限（每卡最多 2 批）`、`迟到（目标卡已到终态）`，落进报告的「遗留（Deferred）」小节即「下轮待办」），**这类条目不要再手写 `finding --stdin`（stdin 加 `"deferred": true`）来记录**。目标卡仍为 `pending` 时 bounce 直接报错（尚未开工，改用 spawn 扩编或 finding 记录）。
     **若就是当前这张刚上报的卡（此刻已在 `reviewing`）**，bounce 后跳过第 4 步不再派审查员，直接走第 5 点两步转移（`rework` → 重 spawn → `working`），把 `bounces` 里的追加指令拼进返工 prompt；**若改的是别的仍在 `working` 的卡**，不动那张卡的状态，只把追加指令排进它施工员的下一次返工 prompt（它自己返工时带上）；
   - 不值得做的 → `node "$LEDGER" finding --stdin` 写 `{"text": "...", "card_id": "<来源卡id>"}` 记成 finding；要留到下一轮的，在同一个 stdin 里加 `"deferred": true`（脚本按 stdin 字段识别并记入 deferred / 报告「下轮待办」）。
4. **spawn 审查代理**（`swarm-reviewer`，后台）：prompt = 任务卡 + 施工员的 result JSON + 设计文档的「卡间依赖与接口约定」章节（走了 2.5 且已归档时），要求**只读**审查，回 PASS 或 FAIL + 逐条意见；审查员的模型同样由宿主按角色决定（`swarm-reviewer` 角色），派工时不要指定，也不要改 agent 文件。
5. **审查员完成** → PASS：`update <卡id> --stdin` 写 `state: "passed"`；FAIL：返工轮次 < `rework_rounds` 上限 → **两步转移，顺序不能颠倒**：
   ```bash
   # ① 先记返工：reviewing → rework（轮次在这一步自动 +1），审查意见随 review 一起归档
   node "$LEDGER" update <卡id> --stdin <<'JSON'
   { "state": "rework", "review": { "verdict": "FAIL", "findings": [...] } }
   JSON
   ```
   然后重 spawn 施工员（prompt = 原卡 + result + 审查意见），**重 spawn 之后**再写回 working：
   ```bash
   # ② 重 spawn 后：rework → working，之后施工员的完成通知照第 1、2 条走
   node "$LEDGER" update <卡id> --stdin <<'JSON'
   { "state": "working" }
   JSON
   ```
   状态机只允许 `reviewing → rework → working`；直接从 reviewing 写 working 会被拒绝。达到上限 → `state: "failed"`
6. **每次状态变化后刷新看板**：`node "$LEDGER" render board` → 脚本自动生成新看板卡片并把 `::visualize` 行输出到 stderr → 原样放进回复正文单独一行。这一步只为聊天流里的卡片；**侧栏「团队看板」面板会自己跟上**（服务端 `fs.watch` 台账变更即推送，面板另有 5 秒兜底轮询），状态一变就更新，无需重复调用 `swarm_board`——面板开过一次就一直在线（会话重启后面板会关，按第 0 步 `resume` 分支重新唤起）。

修复员的完成通知同样进这个循环：按台账状态路由到重跑 gate（见第 5 步）。

## 5. Gate 验证

台账里所有卡进入终态（passed / failed）后，主会话**直接用 Bash** 跑 gate 命令（为空就跳过验证直接收尾，报告会注明无验证命令）：

- 通过 →
  ```bash
  node "$LEDGER" gate pass
  node "$LEDGER" finish completed
  ```
- 不通过 → 先记账再派活：
  ```bash
  node "$LEDGER" gate fail
  ```
  spawn `swarm-fixer` 后台修复（prompt 带 gate 完整输出 + 失败卡信息）；修复员返回后先记录改动，再重跑 gate：
  ```bash
  node "$LEDGER" fixer --stdin <<'JSON'
  { "summary": "修了什么", "files": ["改动的文件"] }
  JSON
  ```
  重跑 gate 后同样用 `gate pass` / `gate fail` 记录当轮结论。修复轮上限 = 台账 `rework_rounds`，达上限仍红 → `node "$LEDGER" gate fail` + `node "$LEDGER" finish failed`。
- 修复员或 gate 阶段发现的、本次不修的问题 → `node "$LEDGER" finding --stdin` 记进报告 findings（`{"text": "...", "card_id": "<相关卡id>"}`）；留到下一轮的在同一 stdin 里加 `"deferred": true` 记入 deferred（报告的「下轮待办」）。

## 6. 报告

```bash
node "$LEDGER" report
```

输出的 markdown 已含每张卡的最终状态、返工轮数、扩编分诊结果（findings / deferred）、gate 结论和**团队角色模型表**（来自台账 `agent_models`，即第 0 步 `show --json` 读到的 5 个角色实际模型与来源）。模型由宿主决定，报告里如实引用台账值，不要声称插件做过模型路由。

**然后生成报告卡片展示**：

```bash
node "$LEDGER" render report
```

脚本自动取台账数据（含 `agent_models` / `rework_rounds`）→ 注入报告模板（结果表格+gate 状态+模型表+待办清单）→ 写入可视化目录 → stderr 输出 `::visualize` 行 → 原样放进回复正文单独一行。用户收到的最后一条回复 = markdown 报告 + 可视化报告卡片。

报告阶段后，侧栏「团队看板」面板显示的就是运行的最终状态（各卡 passed/failed、gate 结论、返工轮数）；台账保留在 `.swarm/ledger.json`，用户随时拉开面板回看这次运行，不用翻聊天记录——直到下次 `/swarm` 覆盖台账为止（旧台账会先归档到 `.swarm/artifacts/<旧 run_id>/ledger-final.json`，面板本身不读归档）。

两件事别忘：未跟踪文件的内容改动平台检测不到，报告里如实披露；运行结束后 `.swarm/ledger.json` 保留备查，不要顺手删。
