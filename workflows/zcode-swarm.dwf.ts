/* zcode-workflow
description: zcode-swarm
  团队开发：按任务卡分头施工，每卡独立审查、按意见返工，最后统一验证；施工中发现的新工作经扩编拆单员分诊后即时增发新工蜂（深度/总量封顶）；全程工具内看板。
whenToUse: 用户通过 /swarm 发布需求后，由主会话以已保存工作流启动（默认零确认：发布需求即确认；
  用户要求先过卡时，经开工阵容卡片确认后再启动）。没有经 /swarm 拆出的任务卡时不要直接运行。
args:
  requirement:
    type: string
    required: true
    description: 本次团队开发的需求原文
  cards:
    type: json
    required: true
    description: 拆单后经用户确认的任务卡数组：[{id, title, task, scope, acceptance, role,
      model}]；model 是插件设置里的模型名单键（light / strong / hard 或自定义键）；名单里写
      inherit 的档位跟随会话模型（运行面板的「子代理模型」可改）
  gate:
    type: string
    default: ""
    description: 全部任务完成后运行的验证命令（项目的测试或构建命令）；空字符串表示不运行
  review_model:
    type: string
    default: "strong"
    description: 独立审查员使用的模型名单键
  splitter_model:
    type: string
    default: "light"
    description: 扩编拆单员使用的模型名单键
  fixer_model:
    type: string
    default: "hard"
    description: 集成修复员使用的模型名单键
  rework_rounds:
    type: number
    default: 2
    description: 每张任务卡审查不通过时最多返工几轮（0-5），也是验证命令失败后最多修复几轮
  spawn_depth:
    type: number
    default: 1
    description: 动态扩编深度（0=关闭，行为同 v0.3.0；1=施工中发现一层；最多 2）
  resolved_models:
    type: json
    default: {}
    description: 启动前由 swarm-config 预检解析出的「档位键→完整模型 id」映射；只用于报告展示，不参与路由
*/
// zcode-swarm 团队开发工作流（由 zcode-swarm 插件管理）
// 模型名单块由 swarm-config.mjs 按插件设置生成：改模型请用 /swarm-settings，不要手改本文件。

// @@SWARM_MODELS_BEGIN
const MODELS: Record<string, ModelRef | undefined> = {
  light: undefined,
  strong: undefined,
  hard: undefined,
};
const MODEL_LABELS: Record<string, string> = {
  light: "跟随会话模型",
  strong: "跟随会话模型",
  hard: "跟随会话模型",
};
// @@SWARM_MODELS_END

interface Card {
  id: string;
  title: string;
  task: string;
  scope: string;
  acceptance: string;
  role: string;
  model: string;
  /** 扩编代数：种子卡 0，扩编卡 = 来源卡 + 1。 */
  gen: number;
  /** 扩编来源卡号；种子卡为空串。 */
  from: string;
}

/** 施工员对"途中发现的、与本需求相关但不在任何任务卡里的独立小工作"的提议。 */
interface SpawnDraft {
  /** 一句话：这件小工作是什么。 */
  title: string;
  /** 具体做什么，自包含。 */
  task: string;
  /** 写入范围（目录/文件），不得与任何已知任务卡重叠。 */
  scope: string;
  /** 完成判据。 */
  acceptance: string;
  /** 角色名，可省略。 */
  role?: string;
  /** 模型名单键，可省略（默认 strong）。 */
  model?: string;
  /** 为什么它与本需求相关、值得现在做。 */
  reason?: string;
}

interface BuildResult {
  /** 本任务创建或修改过的每个文件，工作区相对路径。 */
  changed: string[];
  /** 一两句话：做了什么。 */
  summary: string;
  /** 实际运行过的自检命令及结果，每条一句；没有运行就给空数组。 */
  checks: string[];
  /** 没完成或拿不准的地方，每条一句；没有就给空数组。 */
  open: string[];
  /** 途中发现的独立小工作提议；没有给空数组或省略。 */
  spawns?: SpawnDraft[];
}

interface Verdict {
  /** 只有验收标准的每一条都有证据证明满足时才为 true。 */
  pass: boolean;
  /** 每个问题一条：位置（文件:行号）、问题是什么、为什么不满足验收标准。通过时给空数组。 */
  findings: string[];
  /** 实际核查了什么：读过的文件、运行过的命令，每条一句。 */
  checked: string[];
}

interface GateFix {
  /** 改动过的文件，工作区相对路径。 */
  changed: string[];
  /** 一两句话：判断的失败原因和做的修改。 */
  summary: string;
}

/** 扩编拆单员对一条提议的分诊结论。 */
interface SplitDecision {
  /** add = 增发新卡；bounce = 属于某张已知卡的卡内工作，打回该卡施工员；skip = 不采纳。 */
  verdict: "add" | "skip" | "bounce";
  /** verdict 为 add 时给出的规范任务卡字段。 */
  card: { title: string; task: string; scope: string; acceptance: string; role: string; model: string };
  /** verdict 为 bounce 时：打回哪张卡（任务卡编号）。 */
  target?: string;
  /** 一句话：采纳/打回/不采纳的理由。 */
  reason: string;
}

interface Outcome {
  card: Card;
  passed: boolean;
  rounds: number;
  summary: string;
  findings: string[];
  checked: string[];
  tampered: boolean;
  failure: string;
  /** 吸收的打回追加项（title＋验收），随报告披露。 */
  extras: string[];
}

interface Finding {
  /** 位置：工作区相对路径（适用时带行号），或任务卡标题。 */
  where: string;
  /** 一句话：问题是什么。 */
  what: string;
  /** 依据：审查员的核查记录，或判定它的命令与输出。 */
  evidence: string;
  /** verified：命令或确定性检查判定；unconfirmed：只有单个审查员的判断。 */
  status: "verified" | "unconfirmed";
  /** 严重程度。high 只给数据损坏、崩溃或结果错误。 */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** 两三句话回答这次需求做成了什么。 */
  conclusion: string;
  findings: Finding[];
  /** 这次运行实际核查了什么、怎么核查的。 */
  verified: string[];
  /** 这次运行没有核查到的部分及原因。 */
  notCovered: string[];
}

const GATE_RUNNER =
  "const r=require('child_process').spawnSync(process.argv[1],{shell:true,stdio:'inherit'});" +
  "process.exit(r.status===null?1:r.status);";

const REVIEWER_PERSONA = [
  "你是独立审查员，任务是证明交付有问题——证明不了才判通过。",
  "只读取证，可以运行只读的检查命令；绝不修改、创建或删除任何文件，也不做任何 git 操作。",
  "逐条对照验收标准核对，每条结论都要有证据：文件:行号，或你实际运行的命令及输出。",
  "格式和风格上的个人偏好不构成不通过；不通过只留给：验收标准没达成、交付与任务卡不符、交付引入了缺陷。",
  "验收标准本身无法判定时，升级提问说清楚，不要猜。用中文回答。",
].join("\n");

const FIXER_PERSONA = [
  "你是集成修复员。所有任务卡都已完成，但整体验证命令没有通过，你负责找出原因并做最小修复。",
  "可以修改任何必要的文件，但不要重写别人已经完成的功能，也不要做任何 git 操作。",
  "修不好，或判断验证命令本身有问题时，升级提问说清楚，不要伪造通过。用中文回答。",
].join("\n");

const SPLITTER_PERSONA = [
  "你是扩编拆单员。施工员在干活途中上报了与本需求相关、但不在任何任务卡里的独立小工作提议，你逐条分诊。",
  "判 add 的条件：与本需求直接相关、值得现在做、规模适中（一张卡能完成）、且能给出与所有已知任务卡都不重叠的写入范围。",
  "判 bounce 的条件：这件工作明确是某张已知卡自己的收尾或卡内工作（写入范围完全落在该卡 scope 内，且是该卡任务自身的尾巴）——不要 skip，给 target=那张卡的编号，系统会把它作为追加指令打回该卡施工员当场完成。优先选状态「在施工」的卡。",
  "以下判 skip：与本需求无关或只是将来可能有用；不属于任何一张已知卡或跨多张卡说不清归属；拆不出可验收的判据；重复已有卡的工作且那张卡已收尾。",
  "只做判断和整理字段，不读文件、不运行命令——判断依据就是提议原文和已知卡列表。",
  "给出的卡必须字段完整：title/task/scope/acceptance/role/model（model 从给的名单键里选，按难度定）。用中文回答。",
].join("\n");

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasModel(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODELS, key);
}

/** 按档位造人设：跟随会话模型的档位不写 model，成员就用运行的子代理模型（默认是会话模型）。
 * 返回类型保持窄（不经 AgentPersona 的 string/number 宽联合）：引擎启动期要求 agent() 的 model/budget 静态可知。 */
function persona(system: string, key: string): { system: string; model?: ModelRef } {
  const ref = MODELS[key];
  return ref ? { system, model: ref } : { system };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

function inScope(path: string, scope: string): boolean {
  const p = normalizePath(path);
  const s = normalizePath(scope);
  return s.length > 0 && (p === s || p.startsWith(`${s}/`));
}

function parseCards(raw: unknown): Card[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("参数 cards 必须是非空的任务卡数组");
  }
  const seen: string[] = [];
  const parsed = raw.map((entry: unknown, index: number): Card => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`第 ${index + 1} 张任务卡不是对象`);
    }
    const rec = entry as Record<string, unknown>;
    const card: Card = {
      id: text(rec.id) || String(index + 1),
      title: text(rec.title),
      task: text(rec.task),
      scope: text(rec.scope),
      acceptance: text(rec.acceptance),
      role: text(rec.role) || "开发成员",
      model: text(rec.model) || "strong",
      gen: 0,
      from: "",
    };
    if (!card.title || !card.task || !card.acceptance) {
      throw new Error(`任务卡 ${card.id} 缺少 title、task 或 acceptance`);
    }
    if (seen.includes(card.id)) throw new Error(`任务卡编号重复：${card.id}`);
    seen.push(card.id);
    if (!hasModel(card.model)) {
      throw new Error(`任务卡 ${card.id} 的模型「${card.model}」不在插件设置的模型名单里`);
    }
    return card;
  });
  for (let i = 0; i < parsed.length; i += 1) {
    for (let j = i + 1; j < parsed.length; j += 1) {
      const a = parsed[i].scope;
      const b = parsed[j].scope;
      if (a && b && (inScope(a, b) || inScope(b, a))) {
        throw new Error(`任务卡 ${parsed[i].id} 与 ${parsed[j].id} 的写入范围重叠：${a} / ${b}`);
      }
    }
  }
  return parsed;
}

function builderName(card: Card): string {
  const role = card.role === "独立审查" ? "独立审查员" : card.role;
  return `${role}·任务${card.id}`;
}

function builderPersona(card: Card): string {
  return [
    `你是开发团队里的一名成员，角色是「${card.role}」。你只负责分配给你的这一张任务卡，其他任务卡由并行的同伴负责。`,
    card.scope
      ? `只能在写入范围「${card.scope}」内创建或修改文件；需要改范围外的文件时不要改，在结果里说明理由。`
      : "这张任务卡没有限定写入范围：只做任务需要的改动，并在结果里列出全部改动的文件。",
    "不要做任何 git 操作（提交、切分支、stash、reset 等）。",
    "施工中若发现与本需求相关、但不在你卡里的独立小工作：不要自己做，按结果格式的 spawns 字段提议（写清 title/task/scope/acceptance/role/model/reason），由扩编拆单员决定是否增派人手。",
    "完成后对照验收标准自查。验收标准无法达成或任务卡自相矛盾时，升级提问说清楚，不要绕过。用中文回答。",
  ].join("\n");
}

function buildAsk(requirement: string, card: Card): string {
  return [
    `团队这次的总需求：${requirement || "（见任务卡）"}`,
    "",
    `你的任务卡（编号 ${card.id}：${card.title}）：`,
    card.task,
    "",
    "验收标准：",
    card.acceptance,
    "",
    card.scope ? `写入范围：${card.scope}` : "写入范围：未限定",
    "交付前自查一遍：途中若发现与本需求相关、但不在你任务卡里的独立小工作（比如路线图、规划文档或代码注释里还列着别的待做项），不要自己做——把每一条填进结果的 spawns 字段（title/task/scope/acceptance/role/model/reason 写全），会有拆单员决定是否增派人手。没有发现就省略该字段。",
    "完成后按要求的格式交回结果。",
  ].join("\n");
}

function reviewAsk(card: Card, work: BuildResult, gate: string, extras: string[]): string {
  return [
    `请审查任务卡 ${card.id}「${card.title}」的交付。`,
    "",
    "任务：",
    card.task,
    "",
    "验收标准：",
    card.acceptance,
    "",
    card.scope ? `写入范围：${card.scope}` : "写入范围：未限定",
    `施工方报告改动的文件：${work.changed.length > 0 ? work.changed.join("、") : "（未报告）"}`,
    `施工方的说明：${work.summary}`,
    work.checks.length > 0 ? `施工方的自检：${work.checks.join("；")}` : "施工方没有报告自检。",
    gate
      ? "全部任务完成后脚本会统一运行验证命令，你不需要运行整套测试，只做判断验收标准所需的检查。"
      : "",
    extras.length > 0 ? `本轮并回的追加工作（一并核对）：${extras.join("；")}` : "",
  ].join("\n");
}

function recheckAsk(work: BuildResult, extras: string[]): string {
  return [
    "施工方已按你的意见返工。请重新逐条核对验收标准。",
    ...(extras.length > 0 ? [`本轮还并回了追加工作，请一并核对：${extras.join("；")}`] : []),
    `施工方这次的说明：${work.summary}`,
    `改动的文件：${work.changed.length > 0 ? work.changed.join("、") : "（未报告）"}`,
  ].join("\n");
}

/** 打回的追加指令：把并回本卡的提议交给施工员当场完成。 */
function extraAsk(items: { fromId: string; draft: SpawnDraft }[]): string {
  return [
    "扩编分诊员把以下工作并回你的任务卡（它们本就属于你的写入范围/任务尾巴），请一并完成并与已有交付整合：",
    ...items.map(
      (item, index) =>
        `${index + 1}. ${text(item.draft.title)}：${text(item.draft.task)}${text(item.draft.acceptance) ? `（验收：${text(item.draft.acceptance)}）` : ""}`,
    ),
    "仍在你的写入范围内改；完成后按同样的结果格式交回（spawns 字段照旧，没有就省略）。",
  ].join("\n");
}

function reworkAsk(verdict: Verdict): string {
  return [
    "审查没有通过。请逐条处理下面的意见，仍然只在写入范围内修改，改完按同样格式交回结果：",
    ...verdict.findings.map((finding, index) => `${index + 1}. ${finding}`),
  ].join("\n");
}

function gateFixAsk(gate: string, exitCode: number, tail: string): string {
  return [
    `验证命令「${gate}」没有通过（退出码 ${exitCode}）。输出末尾如下：`,
    tail,
    "请找出原因并修复。脚本会在你之后重新运行验证命令，你不需要自己运行。",
  ].join("\n");
}

function boardRow(card: Card, stage: string, note: string) {
  const tag = card.gen > 0 ? `扩编·来自任务${card.from}｜` : "";
  return {
    id: card.id,
    title: `${card.id}. ${card.title}`,
    stage,
    role: card.role,
    model: MODEL_LABELS[card.model],
    note: (tag + note).length > 200 ? `${(tag + note).slice(0, 200)}…` : tag + note,
  };
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

let gitOk = true;

/** 写入范围内的 git 状态指纹：审查前后不一致，说明审查期间有人动了这张卡的文件。 */
async function scopeSnapshot(card: Card): Promise<string> {
  if (!gitOk || card.scope.length === 0) return "";
  try {
    const diff = await git.diff(undefined, card.scope);
    const status = await git.status();
    const untracked = status.untracked.filter((path) => inScope(path, card.scope)).sort();
    return `${diff}\n${untracked.join("\n")}`;
  } catch {
    return "";
  }
}

const requirement = text(args.requirement);
const cards = parseCards(args.cards);
const gate = text(args.gate);
const reviewKey = text(args.review_model) || "strong";
if (!hasModel(reviewKey)) {
  throw new Error(`审查模型「${reviewKey}」不在插件设置的模型名单里`);
}
const splitterKey = text(args.splitter_model) || "light";
const fixerKey = text(args.fixer_model) || "hard";
for (const [label, key] of [["扩编拆单员", splitterKey], ["集成修复员", fixerKey]] as const) {
  if (!hasModel(key)) throw new Error(`${label}的模型「${key}」不在插件设置的模型名单里`);
}
const reworkArg = args.rework_rounds;
const reworkLimit =
  typeof reworkArg === "number" && Number.isFinite(reworkArg)
    ? Math.max(0, Math.min(5, Math.floor(reworkArg)))
    : 2;
const spawnArg = args.spawn_depth;
const spawnDepth =
  typeof spawnArg === "number" && Number.isFinite(spawnArg)
    ? Math.max(0, Math.min(2, Math.floor(spawnArg)))
    : 1;
const MAX_CARDS = 16;
const resolvedModels: Record<string, string> =
  args.resolved_models && typeof args.resolved_models === "object" && !Array.isArray(args.resolved_models)
    ? Object.fromEntries(
        Object.entries(args.resolved_models as Record<string, unknown>).filter(
          (pair): pair is [string, string] => typeof pair[0] === "string" && typeof pair[1] === "string",
        ),
      )
    : {};

artifact.board("team", {
  title: "团队任务看板",
  key: "id",
  status: "stage",
  columns: ["待施工", "施工中", "审查中", "返工中", "通过", "未通过"],
  cardTitle: "title",
  detail: [
    { field: "role", label: "角色" },
    { field: "model", label: "模型" },
    { field: "note", label: "进展" },
  ],
});

// 越界检测的基线必须在任何施工开始前取样。
let baseline: string[] = [];
try {
  baseline = await git.changedFiles();
} catch {
  gitOk = false;
}

// ---- 动态扩编：回流通道 + 计数关闭（发卡/提议入队前 open++；终态/消费时 open--；归零双关闭）----
const todoCards = channel<Card>("任务卡");
interface Proposal {
  fromId: string;
  draft: SpawnDraft;
  gen: number;
}
const proposals = channel<Proposal>("扩编提议");
const registered: Card[] = [...cards];
let nextSeq = cards.reduce((max, card) => Math.max(max, Number(card.id) || 0), 0) + 1;
const skippedProposals: { fromId: string; title: string; reason: string; deterministic: boolean }[] = [];
// 提议去重：施工和返工轮会重复上报同一条（L3 实跑 9 条里 3 条是双报），同标题+同范围只分诊一次
const seenProposalKeys = new Set<string>();
// 提议打回：分诊员判「属于某卡自己的尾巴」的提议，作为追加指令送回该卡施工员当场完成
const inboxes = new Map<string, { fromId: string; draft: SpawnDraft }[]>();
const cardStates = new Map<string, "running" | "done">();
const bounceBatches = new Map<string, number>(); // 每卡最多吸收的追加批次数，防活锁
const bouncedLog: { toId: string; fromId: string; title: string }[] = [];
const deferredProposals: { fromId: string; title: string; reason: string }[] = [];
const MAX_BOUNCE_BATCHES = 2;
for (const card of cards) inboxes.set(card.id, []);
let open = 0;
let closed = false;
const maybeClose = () => {
  if (open <= 0 && !closed) {
    closed = true;
    proposals.close();
    todoCards.close();
  }
};
for (const card of cards) {
  report(boardRow(card, "待施工", ""), "team");
  open += 1;
  cardStates.set(card.id, "running");
  todoCards.send(card);
}

/** 一张卡的完整流水：施工 → 审查 → 返工；每次施工结果里的扩编提议即时入回流通道。 */
async function processCard(card: Card): Promise<Outcome> {
  const builder = agent(builderName(card), persona(builderPersona(card), card.model));
  const reviewer = agent(`独立审查·任务${card.id}`, persona(REVIEWER_PERSONA, reviewKey));
  const outcome: Outcome = {
    card,
    passed: false,
    rounds: 0,
    summary: "",
    findings: [],
    checked: [],
    tampered: false,
    failure: "",
    extras: [],
  };
  const emitSpawns = (work: BuildResult) => {
    for (const draft of work.spawns ?? []) {
      open += 1; // 入队前计数：提议即使最终被跳过，账也已经记上
      proposals.send({ fromId: card.id, draft, gen: card.gen });
    }
  };
  const extras: string[] = [];
  const extraLine = (item: { draft: SpawnDraft }) =>
    `${text(item.draft.title)}${text(item.draft.acceptance) ? `（验收：${text(item.draft.acceptance)}）` : ""}`;
  // 吸收打回：把并回本卡的追加指令交给施工员当场完成，循环到收件箱清空为止
  const absorbBounces = async (): Promise<"empty" | "absorbed" | "failed"> => {
    let absorbed = false;
    for (;;) {
      const items = (inboxes.get(card.id) ?? []).splice(0);
      if (items.length === 0) return absorbed ? "absorbed" : "empty";
      absorbed = true;
      extras.push(...items.map(extraLine));
      report(boardRow(card, "施工中", `收到打回的追加指令 ${items.length} 条，并入本卡完成`), "team");
      try {
        work = await builder.ask<BuildResult>(extraAsk(items));
        emitSpawns(work);
        outcome.summary = work.summary;
      } catch (error) {
        outcome.failure = `追加指令没有交回有效结果：${String(error)}`;
        return "failed";
      }
    }
  };
  // 终局：迟到的打回不再吸收，转入下轮待办；本段无 await，与分诊侧的状态判断不竞争
  const finalizeTerminal = () => {
    const leftover = (inboxes.get(card.id) ?? []).splice(0);
    for (const item of leftover) {
      deferredProposals.push({ fromId: item.fromId, title: text(item.draft.title), reason: `到达时任务${card.id}已收尾` });
    }
    cardStates.set(card.id, "done");
  };

  report(boardRow(card, "施工中", "开始施工"), "team");
  let work: BuildResult;
  try {
    work = await builder.ask<BuildResult>(buildAsk(requirement, card));
    emitSpawns(work);
  } catch (error) {
    outcome.failure = `施工没有交回有效结果：${String(error)}`;
    finalizeTerminal();
    report(boardRow(card, "未通过", outcome.failure), "team");
    return outcome;
  }
  if ((await absorbBounces()) === "failed") {
    finalizeTerminal();
    report(boardRow(card, "未通过", outcome.failure), "team");
    return outcome;
  }
  outcome.summary = work.summary;

  let prevFindings = "";
  for (let round = 0; round <= reworkLimit; round += 1) {
    report(boardRow(card, "审查中", round === 0 ? "首次审查" : `第 ${round} 次返工后复审`), "team");
    const before = await scopeSnapshot(card);
    let verdict: Verdict;
    try {
      verdict = await reviewer.ask<Verdict>(round === 0 ? reviewAsk(card, work, gate, extras) : recheckAsk(work, extras));
    } catch (error) {
      outcome.failure = `审查没有交回有效结论：${String(error)}`;
      break;
    }
    const after = await scopeSnapshot(card);
    outcome.findings = verdict.findings;
    outcome.checked = verdict.checked;
    if (before !== after) {
      outcome.tampered = true;
      outcome.failure = "审查期间写入范围内的文件被改动，这次审查结论作废，需要人工复核";
      break;
    }
    if (verdict.pass) {
      // 通过时也查一次收件箱：期间可能有打回到达，吸收后需复审覆盖（吸收批次另有上限，不烧返工轮数）
      const absorbed = await absorbBounces();
      if (absorbed === "failed") break;
      if (absorbed === "absorbed") {
        round -= 1;
        continue;
      }
      outcome.passed = true;
      break;
    }
    // 重复意见早停：返工后审查给出与上一轮完全相同的意见，说明返工没有生效，
    // 继续烧轮数只会重复同样的施工+审查开销——停下交给人。
    const findingsKey = verdict.findings.join("\n");
    if (round >= 1 && findingsKey === prevFindings) {
      outcome.failure = "审查意见与上一轮完全相同：返工没有生效，不再消耗返工轮数，需要人工处理";
      break;
    }
    prevFindings = findingsKey;
    if (round === reworkLimit) {
      outcome.failure = reworkLimit > 0 ? `返工 ${reworkLimit} 轮后仍未通过审查` : "未通过审查（设置为不返工）";
      break;
    }
    outcome.rounds = round + 1;
    report(boardRow(card, "返工中", verdict.findings[0] ?? "按审查意见修改"), "team");
    try {
      work = await builder.ask<BuildResult>(reworkAsk(verdict));
      emitSpawns(work);
    } catch (error) {
      outcome.failure = `返工没有交回有效结果：${String(error)}`;
      break;
    }
    if ((await absorbBounces()) === "failed") break;
    outcome.summary = work.summary;
  }
  outcome.extras = extras;
  finalizeTerminal();
  report(
    boardRow(card, outcome.passed ? "通过" : "未通过", outcome.passed ? outcome.summary : outcome.failure),
    "team",
  );
  return outcome;
}

const outcomes: Outcome[] = [];
const team = future(async () => {
  phase("分头施工、独立审查、按需返工与扩编上报");
  log(
    `共 ${cards.length} 张种子任务卡，审查使用 ${MODEL_LABELS[reviewKey]}，扩编拆单 ${MODEL_LABELS[splitterKey]}，` +
      `集成修复 ${MODEL_LABELS[fixerKey]}；每张最多返工 ${reworkLimit} 轮，扩编深度 ${spawnDepth}`,
  );
  const runs: Promise<void>[] = [];
  for await (const card of todoCards) {
    runs.push(
      (async () => {
        const outcome = await processCard(card);
        outcomes.push(outcome);
        open -= 1;
        maybeClose();
      })(),
    );
  }
  await Promise.all(runs);
});

const splitter = agent("扩编拆单员", persona(SPLITTER_PERSONA, splitterKey));
const dispatch = future(async () => {
  phase("分诊扩编提议：值得做的即刻增发新工蜂");
  for await (const proposal of proposals) {
    const consume = (reason: string, deterministic: boolean, title?: string) => {
      skippedProposals.push({
        fromId: proposal.fromId,
        title: title ?? text(proposal.draft.title),
        reason,
        deterministic,
      });
      open -= 1;
      maybeClose();
    };
    const proposalKey = `${normalizePath(text(proposal.draft.scope))}|${text(proposal.draft.title)}`;
    if (seenProposalKeys.has(proposalKey)) {
      consume("重复提议：与已分诊过的一条同标题同范围（施工/返工轮双报），不重复分诊", true);
      continue;
    }
    seenProposalKeys.add(proposalKey);
    if (proposal.gen + 1 > spawnDepth) {
      consume(`超过扩编深度上限（${spawnDepth}）`, true);
      continue;
    }
    if (registered.length >= MAX_CARDS) {
      consume(`任务卡总数已达上限 ${MAX_CARDS}`, true);
      continue;
    }
    let decision: SplitDecision;
    try {
      decision = await splitter.ask<SplitDecision>(
        [
          `总需求：${requirement || "（见提议）"}`,
          `提议来自任务卡 ${proposal.fromId} 的施工员，原文：${JSON.stringify(proposal.draft)}`,
          `已知任务卡（编号[写入范围][状态]）：${registered
            .map((c) => `${c.id}[${c.scope || "无"}][${cardStates.get(c.id) === "running" ? "在施工，可打回" : "已收尾"}]`)
            .join("、")}`,
          `模型名单键：${Object.keys(MODELS).join(" / ")}`,
          "请分诊：值得现在做且范围与所有已知卡不重叠的判 add；属于某张「在施工」卡自己的卡内工作/尾巴的判 bounce 并给 target=那张卡编号；其余判 skip 并给理由。",
        ].join("\n"),
      );
    } catch (error) {
      consume(`拆单员没有交回有效结论：${String(error)}`, false);
      continue;
    }
    if (decision.verdict === "bounce") {
      const targetId = text(decision.target);
      const running = cardStates.get(targetId) === "running";
      const inbox = inboxes.get(targetId);
      const batches = bounceBatches.get(targetId) ?? 0;
      if (running && inbox && batches < MAX_BOUNCE_BATCHES) {
        bounceBatches.set(targetId, batches + 1);
        inbox.push({ fromId: proposal.fromId, draft: proposal.draft });
        bouncedLog.push({ toId: targetId, fromId: proposal.fromId, title: text(proposal.draft.title) });
        log(`提议打回：任务${proposal.fromId}「${text(proposal.draft.title)}」→ 任务${targetId} 施工员作为追加指令完成`);
      } else {
        // 防御式分流：running / 收件箱存在 / 未超批 三者缺一都转「下轮待办」，不做非空断言
        const reason = !inbox
          ? `目标卡 ${targetId || "（未给出）"} 收件箱缺失（未注册或已释放）`
          : running
            ? `任务${targetId} 的追加批次已达上限（${MAX_BOUNCE_BATCHES}）`
            : `目标卡 ${targetId || "（未给出）"} 已收尾或不存在`;
        deferredProposals.push({
          fromId: proposal.fromId,
          title: text(proposal.draft.title),
          reason,
        });
      }
      open -= 1; // 提议的计数信用在此了结：目标卡完成时只减它自己那一次
      maybeClose();
      continue;
    }
    if (decision.verdict !== "add") {
      consume(decision.reason, false);
      continue;
    }
    const card: Card = {
      id: String(nextSeq),
      title: text(decision.card.title),
      task: text(decision.card.task),
      scope: text(decision.card.scope),
      acceptance: text(decision.card.acceptance),
      role: text(decision.card.role) || "开发成员",
      model: text(decision.card.model) || "strong",
      gen: proposal.gen + 1,
      from: proposal.fromId,
    };
    const valid =
      card.title.length > 0 &&
      card.task.length > 0 &&
      card.acceptance.length > 0 &&
      card.scope.length > 0 &&
      hasModel(card.model) &&
      !registered.some(
        (known) => known.scope && (inScope(card.scope, known.scope) || inScope(known.scope, card.scope)),
      );
    if (!valid) {
      consume("拆单员给出的卡未通过硬校验（字段/模型键/范围冲突）", true, card.title);
      continue;
    }
    nextSeq += 1;
    registered.push(card);
    log(`扩编 +1：任务${card.id}「${card.title}」（来自任务${card.from}）`);
    report(boardRow(card, "待施工", ""), "team");
    inboxes.set(card.id, []);
    cardStates.set(card.id, "running");
    todoCards.send(card);
  }
});

await Promise.all([team, dispatch]); // 汇合点：所有卡终态且无待分诊提议，扩编才算结束

// 汇总要等全部任务卡（含扩编卡）结束：范围核查看的是整体改动。
const scopedCards = registered.filter((card) => card.scope.length > 0);
let outOfScope: string[] = [];
let changedAfterTeam: string[] = [];
if (gitOk) {
  try {
    changedAfterTeam = await git.changedFiles();
    outOfScope = changedAfterTeam.filter(
      (path) => !baseline.includes(path) && !scopedCards.some((card) => inScope(path, card.scope)),
    );
  } catch {
    gitOk = false;
  }
}

let gateRan = false;
let gatePassed = false;
let gateFixRounds = 0;
let gateTail = "";
if (gate) {
  phase("运行验证命令");
  let check = await world.run("node", ["-e", GATE_RUNNER, gate], {
    timeoutMs: 1_800_000,
    output: { tail: 16_384 },
  });
  if (check.exitCode !== 0 && reworkLimit > 0) {
    const fixer = agent("集成修复员", persona(FIXER_PERSONA, fixerKey));
    for (let round = 1; round <= reworkLimit && check.exitCode !== 0; round += 1) {
      phase("验证没过：修复后重跑");
      log(`验证命令没有通过，第 ${round} 轮修复`);
      gateFixRounds = round;
      const tail = `${check.stdout}\n${check.stderr}`.slice(-4000);
      await fixer.ask<GateFix>(gateFixAsk(gate, check.exitCode, tail));
      check = await world.run("node", ["-e", GATE_RUNNER, gate], {
        timeoutMs: 1_800_000,
        output: { tail: 16_384 },
      });
    }
  }
  gateRan = true;
  gatePassed = check.exitCode === 0;
  gateTail = `${check.stdout}\n${check.stderr}`.slice(-2000).trim();
}

// 集成修复员的改动发生在团队范围核查之后：单独比对并向用户披露（未经独立审查）。
const fixerTouched: string[] = [];
let fixerOutOfScope: string[] = [];
if (gitOk && gateRan && gateFixRounds > 0) {
  try {
    const changedFinal = await git.changedFiles();
    for (const path of changedFinal) {
      if (!changedAfterTeam.includes(path)) fixerTouched.push(path);
    }
    fixerOutOfScope = fixerTouched.filter(
      (path) => !scopedCards.some((card) => inScope(path, card.scope)),
    );
  } catch {
    gitOk = false;
  }
}

const spawnedCount = registered.length - cards.length;
const passedCount = outcomes.filter((outcome) => outcome.passed).length;
const findings: Finding[] = [];
for (const outcome of outcomes) {
  if (outcome.passed) continue;
  findings.push({
    where: outcome.card.scope || `任务卡 ${outcome.card.id}「${outcome.card.title}」`,
    what: outcome.failure || "未通过审查",
    evidence:
      outcome.findings.length > 0
        ? outcome.findings.join("；")
        : outcome.checked.length > 0
          ? outcome.checked.join("；")
          : "无",
    status: outcome.tampered ? "verified" : "unconfirmed",
    severity: outcome.tampered ? "high" : "medium",
  });
}
for (const path of outOfScope) {
  findings.push({
    where: path,
    what: "改动落在所有任务卡的写入范围之外",
    evidence: "运行前后的 git 改动对比",
    status: "verified",
    severity: scopedCards.length === registered.length ? "medium" : "low",
  });
}
if (gateRan && !gatePassed) {
  findings.push({
    where: gate,
    what: gateFixRounds > 0 ? `验证命令修复 ${gateFixRounds} 轮后仍未通过` : "验证命令没有通过",
    evidence: gateTail || "无输出",
    status: "verified",
    severity: "high",
  });
}
// 未采纳的提议只进报告的专属小节，不进 findings——"需要你处理"只留真正要用户动作的项
for (const path of fixerOutOfScope) {
  findings.push({
    where: path,
    what: "集成修复员在所有任务卡的写入范围之外改动了此文件（发生在范围核查之后，未经独立审查）",
    evidence: "修复阶段前后的 git 改动对比",
    status: "verified",
    severity: "low",
  });
}

const spawnLine =
  spawnedCount + skippedProposals.length + bouncedLog.length + deferredProposals.length > 0
    ? `；扩编 +${spawnedCount}、未采纳 ${skippedProposals.length}、打回卡内 ${bouncedLog.length}、下轮待办 ${deferredProposals.length}`
    : "";
const gateLine = gateRan
  ? `验证命令 \`${gate}\`：${gatePassed ? "通过" : "未通过"}${gateFixRounds > 0 ? `（修复 ${gateFixRounds} 轮）` : ""}`
  : "没有配置验证命令";
const lines: string[] = [
  `# 团队施工报告：${passedCount}/${registered.length} 张任务卡通过`,
  "",
  `**需求**：${requirement || "（未提供）"}`,
  "",
  "| 任务卡 | 角色 | 模型 | 结果 | 返工 | 说明 |",
  "|---|---|---|---|---|---|",
  ...outcomes.map(
    (outcome) =>
      `| ${cell(
        `${outcome.card.id}. ${outcome.card.title}${outcome.card.gen > 0 ? `（扩编·来自任务${outcome.card.from}）` : ""}`,
      )} | ${cell(outcome.card.role)} | ${cell(MODEL_LABELS[outcome.card.model])} | ${
        outcome.passed ? "✅ 通过" : "❌ 未通过"
      } | ${outcome.rounds} | ${cell(
        (outcome.passed ? outcome.summary : outcome.failure) +
          (outcome.extras.length > 0 ? `（含打回追加 ${outcome.extras.length} 项）` : ""),
      )} |`,
  ),
  "",
  "## 验证",
  gateLine,
];
if (Object.keys(resolvedModels).length > 0) {
  lines.push(
    "",
    "## 模型（启动前解析，来自 swarm-config 预检）",
    ...Object.entries(resolvedModels).map(([key, id]) => `- ${key} → ${id}`),
  );
}
if (gateRan && gateTail) lines.push("", "```text", gateTail, "```");
if (fixerTouched.length > 0) {
  lines.push(
    "",
    "## 集成修复员改动（未经独立审查）",
    ...fixerTouched.map(
      (path) => `- ${path}${fixerOutOfScope.includes(path) ? "（写入范围之外）" : ""}`,
    ),
  );
}
if (skippedProposals.length > 0) {
  lines.push("", "## 扩编未采纳的提议");
  for (const skipped of skippedProposals) {
    lines.push(`- 来自任务${skipped.fromId}「${cell(skipped.title)}」：${cell(skipped.reason)}`);
  }
}
if (bouncedLog.length > 0) {
  lines.push("", "## 追加指令（打回卡内完成）");
  for (const bounced of bouncedLog) {
    lines.push(`- 任务${bounced.toId} 施工员收到「${cell(bounced.title)}」（来自任务${bounced.fromId} 的提议）`);
  }
}
if (deferredProposals.length > 0) {
  lines.push("", "## 下轮待办（本轮未消化的提议）");
  for (const deferred of deferredProposals) {
    lines.push(`- 「${cell(deferred.title)}」（来自任务${deferred.fromId}）：${cell(deferred.reason)}`);
  }
}
if (findings.length > 0) {
  lines.push("", "## 需要你处理");
  for (const finding of findings) lines.push(`- **${finding.where}**：${finding.what}`);
}
await artifact.markdown("report", lines.join("\n"), {
  title: "团队施工报告",
  description: `${passedCount}/${registered.length} 张任务卡通过独立审查${spawnLine}；${gateLine}。`,
  primary: true,
});

const verified: string[] = [`${outcomes.length} 张任务卡（含扩编）各由一名独立审查员逐条对照验收标准核对`];
if (gateRan) verified.push(gateLine);
if (gitOk) verified.push("运行前后的 git 改动对比：写入范围核查、审查员是否改动文件");
const notCovered: string[] = [];
if (!gateRan) notCovered.push("没有配置验证命令，整体没有用命令验证");
if (!gitOk) notCovered.push("工作区不是 git 仓库或 git 不可用，没有做写入范围核查和审查员改动检查");
if (gitOk && baseline.length > 0) notCovered.push(`运行前已有未提交改动的 ${baseline.length} 个文件不参与写入范围核查`);
if (gitOk) notCovered.push("审查员对未跟踪文件内容的修改检测不到");
if (gateFixRounds > 0) {
  notCovered.push(`集成修复员为过验证命令改动了 ${fixerTouched.length} 个文件，未经独立审查员复核（其中 ${fixerOutOfScope.length} 个在写入范围之外）`);
}
if (spawnDepth === 0) notCovered.push("动态扩编已关闭（spawn_depth=0），施工中发现的相关工作不会增派人手");
if (deferredProposals.length > 0) notCovered.push(`${deferredProposals.length} 条提议未能打回（目标卡已收尾/超上限），列为下轮待办`);
if (bouncedLog.length > 0) notCovered.push(`打回卡内的 ${bouncedLog.length} 条追加指令由施工员自报完成，审查员按验收标准一并核对但未单独复核其必要性`);
if (scopedCards.length < registered.length) notCovered.push("没有写入范围的任务卡无法做越界和审查员改动检查");

const result: WorkflowReport = {
  conclusion:
    `${passedCount}/${registered.length} 张任务卡通过独立审查${spawnLine}；${gateLine}` +
    (outOfScope.length > 0 ? `；有 ${outOfScope.length} 处改动超出写入范围` : "") +
    "。",
  findings,
  verified,
  notCovered,
};
return result;
