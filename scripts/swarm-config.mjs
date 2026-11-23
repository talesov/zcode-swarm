#!/usr/bin/env node
/**
 * swarm-config — zcode-swarm 的项目设置与团队工作流渲染。
 *
 * 「模型」不由本插件配置：团队成员的模型 100% 由宿主「子智能体」设置决定
 *   ZCode 设置 → 子智能体 → ZCode Swarm（每个角色单独设，落盘 ~/.zcode/v2/agents-state.json
 *   的 pluginAgentModelSelectionOverrides）。没设的角色 = 继承默认 = 跟随主会话模型。
 *   show 会列出 5 个角色（planner/architect/builder/reviewer/fixer）的实际模型与来源。
 *
 * 本插件的设置只剩「返工轮数」：
 *   全局单文件 ~/.zcode/zcode-swarm/settings.json（v2）：
 *     { "version": 2, "default": <设置>, "projects": { "<工作区键>": <设置>, ... } }
 *     工作区键 = 项目根目录的规范化小写正斜杠路径；没有项目条目的项目用 default。
 *     default 只是兜底：在 default 作用域下写入（set / reset）会先物化成本项目条目 projects[本项目键]，
 *     全局 default 保持原值不动——单项目的改动不污染别的项目。
 *   项目覆盖 <项目根>/.swarm.json：存在即优先，编辑也写回它；默认不创建、不写项目目录。
 *   设置对象 = { "rework_rounds": N }。旧文件里的 models / review_model 字段读取时静默丢弃（已废弃）。
 *
 * 工作流仍按「模板 + 设置」渲染（部署/工具链用途；v2 起不再作为开工入口）：
 *   ~/.zcode/workflows/zcode-swarm-<键哈希>.dwf.ts（当前项目）＋ zcode-swarm.dwf.ts（兜底，兼容旧名）。
 * v2.0 的开工入口是在 ZCode 里发送 /swarm <需求>，主会话直接编排 Agent；不要写死工作流名启动。
 *
 * 宿主设置层（只读）：ZCode 设置界面 → 插件配置里只剩 reworkRounds 一项，落在宿主
 * ~/.zcode/cli/config.json 的 plugins.options 下。只有当作用域是 global default 时生效——不写盘。
 * 宿主配置永不修改：改这里请走设置界面。

作用域解析顺序：--project <path> > 环境变量 SWARM_PROJECT > 进程当前目录。

  show [--json]                          当前作用域设置 + 5 个角色的实际模型与来源
  set (--stdin | --json <str> | --file <path>)   校验并保存 rework_rounds 到当前作用域、重渲染工作流
  reset                                  当前作用域恢复默认设置
  render [--quiet] / ensure [--quiet]    重渲染 / 按需重渲染当前作用域的工作流，并同步兜底工作流
                                         zcode-swarm.dwf.ts（部署自检读的那一份；钩子用 ensure）
  check-cards (--stdin | --file <path>) [--table]   启动前校验任务卡
  validate (--stdin | --file <path>) [--table]      拆单后一次性预校验，输出 { cards, workflow }

模型表格（agent_models）由主会话按 show 的 roles 写入台账，仅供报告展示。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(HERE, '..', 'workflows', 'zcode-swarm.dwf.ts');
const SETTINGS_DIR = join(homedir(), '.zcode', 'zcode-swarm');
const SETTINGS = join(SETTINGS_DIR, 'settings.json');
const WORKFLOWS = join(homedir(), '.zcode', 'workflows');
/** 宿主配置（ZCode 设置界面 → 插件配置的落盘处）：只读，永不修改。 */
const HOST_CONFIG = join(homedir(), '.zcode', 'cli', 'config.json');
/**
 * 宿主「子智能体」设置（ZCode 设置界面 → 子智能体 → 每个 agent 的模型）：只读。
 * 这是团队模型的唯一来源：它压过 agent 文件里的 modelSelection。
 * 插件侧不存在任何模型名单或档位。
 */
const AGENTS_STATE = join(homedir(), '.zcode', 'v2', 'agents-state.json');
/** 本插件注册的角色（用于识别宿主 per-agent 覆盖）。 */
const PLUGIN_ROLES = ['swarm-planner', 'swarm-architect', 'swarm-builder', 'swarm-reviewer', 'swarm-fixer'];
const PLUGIN_NAME = 'zcode-swarm';
const DEFAULT_WORKFLOW = 'zcode-swarm';
/** 项目根的可选覆盖文件名：存在即优先，编辑写回它；插件默认不创建。 */
const OVERRIDE = '.swarm.json';

/** 跟随会话模型：角色没被宿主单独指定时，跟随主代理模型。 */
export const INHERIT = 'inherit';
const INHERIT_LABEL = '跟随会话模型';
/**
 * 插件不再配置模型：团队成员的模型 100% 由宿主「子智能体」设置决定
 * （ZCode 设置 → 子智能体 → ZCode Swarm，落盘 ~/.zcode/v2/agents-state.json）。
 * 插件设置里只剩「返工轮数」这一个运行时参数。
 */
const DEFAULTS = {
  version: 1,
  rework_rounds: 2,
};

/** 默认设置（纯设置对象，不带 version——version 属于全局文件结构，不属于设置本身）。 */
function defaultRoster() {
  const { version: _version, ...roster } = structuredClone(DEFAULTS);
  return roster;
}
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._\-/]*(\$[a-z]+)?$/;
const BLOCK_RE = /^\/\/ @@SWARM_MODELS_BEGIN.*\r?\n[\s\S]*?^\/\/ @@SWARM_MODELS_END[^\n]*$/m;

function die(message, code = 2) {
  console.error(`[swarm-config] ERROR: ${message}`);
  process.exit(code);
}

function info(message, quiet = false) {
  if (!quiet) console.error(`[swarm-config] ${message}`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function sha12(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/** 模型 id 拆成供应商 / 模型 / 推理级别：供应商是第一个「/」之前那段（与引擎和 ListModels 的写法一致）。 */
export function parseModelId(id) {
  const [base, level = ''] = id.split('$');
  const slash = base.indexOf('/');
  return {
    base,
    level,
    provider: slash >= 0 ? base.slice(0, slash) : '',
    name: slash >= 0 ? base.slice(slash + 1) : base,
  };
}

/** "GLM-5.3$high" → "GLM-5.3 high（未指定供应商）"；"provider/model$max" → "model max（provider）"；inherit → 跟随会话模型。 */
export function modelLabel(id) {
  if (id === INHERIT) return INHERIT_LABEL;
  const { level, provider, name } = parseModelId(id);
  const where = provider ? provider.replace(/^account:/, '') : '未指定供应商';
  return `${name}${level ? ` ${level}` : ''}（${where}）`;
}

/**
 * 校验并规范化设置；problems 非空时 settings 不可用。
 * strict（写入时用）：不再接受没写供应商的裸名——它只在会话供应商里解析，换个会话就启动失败。
 * strict 为 true 时检查全部条目（整份替换）；
 * 旧设置里还没迁移的裸名不拦（由启动预检兜底）；不 strict 时裸名照常加载。
 */
export function validateSettings(raw, { strict = false } = {}) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings: null, problems: ['设置必须是 JSON 对象'] };
  }
  // 插件设置只剩 rework_rounds。旧版本文件里的 models / review_model 字段不再报错，
  // 而是静默丢弃并给出一次性提示——0.4.x 之前写的名单文件不该让升级后的命令直接失败。
  const ignored = [];
  for (const key of Object.keys(raw)) {
    if (['version', 'models', 'review_model', 'rework_rounds'].includes(key)) {
      if (key === 'models' || key === 'review_model') {
        if (raw[key] !== undefined) ignored.push(key);
      }
      continue;
    }
    problems.push(`未知字段：${key}`);
  }
  const rounds = raw.rework_rounds === undefined ? DEFAULTS.rework_rounds : raw.rework_rounds;
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 5) problems.push('rework_rounds 必须是 0 到 5 的整数');
  if (problems.length > 0) return { settings: null, problems };
  return { settings: { version: 1, rework_rounds: rounds }, problems, ignoredFields: ignored };
}

/** 名单对象校验：走 validateSettings（version 字段可有可无），去掉 version 存纯名单。 */
function validateRosterObj(raw, opts) {
  const { settings, problems, ignoredFields } = validateSettings(raw, opts);
  if (!settings) return { roster: null, problems, ignoredFields };
  const { version: _version, ...roster } = settings;
  return { roster, problems, ignoredFields };
}

/** 工作区键：项目根目录路径的规范化小写正斜杠形式（Windows 盘符路径也归一）。 */
function normalizeKey(dir) {
  return resolve(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function workflowNameFor(key) {
  return key ? `${DEFAULT_WORKFLOW}-${createHash('sha256').update(key).digest('hex').slice(0, 10)}` : DEFAULT_WORKFLOW;
}

function workspaceDir(args) {
  const explicit = typeof args?.project === 'string' && args.project.trim() ? args.project : process.env.SWARM_PROJECT;
  return resolve(explicit || process.cwd());
}

/**
 * 全局单文件（v2：default + projects 映射）。
 * v1 扁平文件在内存里迁移成 default，并立即用 writeAtomic 把 v2 结构写回——
 * 否则 show 一路显示迁移后的名单、磁盘却还是扁平文件，用户手改时看到的是另一个版本。
 */
function readGlobalSettings() {
  if (!existsSync(SETTINGS)) {
    return { version: 2, default: defaultRoster(), projects: {} };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (error) {
    die(`全局设置文件不是合法 JSON：${SETTINGS}（${error.message}）——可先备份后用 set --stdin 重写`);
  }
  if (raw && raw.version === 2) {
    const problems = [];
    const legacyEntries = [];
    const def = validateRosterObj(raw.default ?? {});
    if (!def.roster) problems.push(`default：${def.problems.join('；')}`);
    if (Array.isArray(def.ignoredFields) && def.ignoredFields.length > 0) legacyEntries.push('default');
    const projects = {};
    for (const [key, value] of Object.entries(raw.projects ?? {})) {
      const entry = validateRosterObj(value);
      if (!entry.roster) problems.push(`projects[${key}]：${entry.problems.join('；')}`);
      else {
        projects[key] = entry.roster;
        if (Array.isArray(entry.ignoredFields) && entry.ignoredFields.length > 0) legacyEntries.push(`projects[${key}]`);
      }
    }
    if (problems.length > 0) die(`全局设置文件无效：${SETTINGS}\n  - ${problems.join('\n  - ')}`);
    const normalized = { version: 2, default: def.roster, projects };
    // 旧文件里还留着已废弃的 models / review_model 时，一次性把磁盘写成新 schema（只留 rework_rounds）：
    // 否则每次都在内存里清洗、磁盘永远停在旧形状，部署自检的 settings 戳会一直对不上。
    if (legacyEntries.length > 0) {
      try {
        writeAtomic(SETTINGS, `${JSON.stringify(normalized, null, 2)}\n`);
        info(`设置文件里的 ${legacyEntries.join(' / ')} 含已废弃的模型字段，已按新 schema（只留 rework_rounds）写回磁盘。`);
      } catch (err) {
        info(`旧模型字段未能写回磁盘（${err.message}）——本次仍按清洗后的值运行。`);
      }
    }
    return normalized;
  }
  const legacy = validateRosterObj(raw ?? {});
  if (!legacy.roster) {
    die(`全局设置文件无效（既不是 v2 也不是可迁移的 v1 名单）：${SETTINGS}\n  - ${legacy.problems.join('\n  - ')}`);
  }
  const migrated = { version: 2, default: legacy.roster, projects: {} };
  writeAtomic(SETTINGS, `${JSON.stringify(migrated, null, 2)}\n`);
  info(`全局设置是旧版 v1 扁平格式，已迁移并写回 v2：${SETTINGS}`);
  return { ...migrated, migratedFrom: 'v1' };
}

/**
 * 宿主设置层（只读）：ZCode 设置界面 → 插件配置里的 userConfig 五项
 * （只剩 reworkRounds；模型项已废弃）。
 * 实测落盘在 ~/.zcode/cli/config.json 的 plugins.options；键格式未公开，两种都容错：
 *   options["zcode-swarm"] = { defaultLightModel: "provider/model$level", ... }   嵌套对象
 *   options["zcode-swarm.defaultLightModel"] = "provider/model$level"             扁平键
 * 文件不存在 / JSON 解析失败 / 没有 options 对象 → 返回 null（宿主层为空）。
 * 只收非空值；返回 { reworkRounds }。
 */
function cleanHostValue(value) {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function hostOption(options, name) {
  // 嵌套对象：options["zcode-swarm"]（也容忍带市场的安装键 "zcode-swarm@<市场名>"）
  for (const key of Object.keys(options)) {
    if (key.split('@')[0] !== PLUGIN_NAME) continue;
    const value = options[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const nested = cleanHostValue(value[name]);
    if (nested !== undefined) return nested;
  }
  // 扁平键：options["zcode-swarm.defaultLightModel"]（安装键形式 "zcode-swarm@<市场名>.defaultLightModel" 同收）
  for (const key of Object.keys(options)) {
    if (!key.startsWith(`${PLUGIN_NAME}.`) && !key.startsWith(`${PLUGIN_NAME}@`)) continue;
    const dot = key.indexOf('.');
    if (dot < 0 || key.slice(dot + 1) !== name) continue;
    const flat = cleanHostValue(options[key]);
    if (flat !== undefined) return flat;
  }
  return undefined;
}

function readHostLayer() {
  if (!existsSync(HOST_CONFIG)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(HOST_CONFIG, 'utf8'));
  } catch {
    return null; // 宿主文件坏掉不阻断：当作宿主层为空
  }
  const options =
    raw && typeof raw === 'object' && raw.plugins && typeof raw.plugins === 'object' && raw.plugins.options &&
    typeof raw.plugins.options === 'object' && !Array.isArray(raw.plugins.options)
      ? raw.plugins.options
      : null;
  if (!options) return null;
  const host = {};
  // 模型项的宿主覆盖（defaultLight/Strong/HardModel、defaultReviewTier）随三档一起废弃，不再读取。
  const roundsRaw = hostOption(options, 'reworkRounds');
  const rounds = typeof roundsRaw === 'number' ? roundsRaw : typeof roundsRaw === 'string' ? Number(roundsRaw) : NaN;
  if (Number.isFinite(rounds)) host.reworkRounds = rounds;
  return Object.keys(host).length > 0 ? host : null;
}

/**
 * 读宿主「子智能体」设置里属于本插件的 per-agent 模型覆盖（只读，坏文件当作没有）。
 * 返回 [{ role, modelId }]；空数组表示没有任何角色被宿主单独设定。
 */
function readAgentOverrides() {
  if (!existsSync(AGENTS_STATE)) return [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(AGENTS_STATE, 'utf8'));
  } catch {
    return [];
  }
  const map = raw && typeof raw === 'object' ? raw.pluginAgentModelSelectionOverrides : null;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const out = [];
  for (const role of PLUGIN_ROLES) {
    const key = `plugin:zcode-swarm@zcode-swarm-market:${role}`;
    const sel = map[key];
    if (!sel || typeof sel !== 'object') continue;
    const providerId = typeof sel.providerId === 'string' ? sel.providerId : '';
    const modelId = typeof sel.modelId === 'string' ? sel.modelId : '';
    if (!modelId) continue;
    const level = sel.options && typeof sel.options.reasoningLevel === 'string' ? `$${sel.options.reasoningLevel}` : '';
    out.push({ role, modelId: providerId ? `${providerId}/${modelId}${level}` : `${modelId}${level}` });
  }
  return out;
}

function applyHostLayer(roster, host) {
  if (!host) return { roster, applied: {} };
  const next = structuredClone(roster);
  const applied = {};
  // 模型不再受插件设置管：宿主层的 defaultLight/Strong/HardModel / defaultReviewTier 已废弃，
  // 只剩返工轮数这一项运行时参数仍可由宿主插件配置覆盖。
  if (
    host.reworkRounds !== undefined &&
    Number.isInteger(host.reworkRounds) &&
    host.reworkRounds >= 0 &&
    host.reworkRounds <= 5
  ) {
    next.rework_rounds = host.reworkRounds;
    applied.reworkRounds = host.reworkRounds;
  }
  return { roster: next, applied };
}

/**
 * 当前作用域：--project / SWARM_PROJECT / cwd → 键；项目根有 .swarm.json 用它（source=override），
 * 否则用全局 projects[键]（source=project）或 default（source=default）。
 * 返回 { dir, key, source, overridePath?, roster, stored, host, hostApplied, workflowName, global }。
 * roster = 本次解析的生效名单（default 作用域会叠加宿主层）；stored = 来源里的原名单（落盘/渲染用它，
 * 宿主层值不写进任何文件）；host = 宿主层原值（只有 default 作用域才读），hostApplied = 实际生效的覆盖项。
 */
function loadContext(args = {}) {
  const dir = workspaceDir(args);
  const key = normalizeKey(dir);
  const overridePath = join(dir, OVERRIDE);
  if (existsSync(overridePath)) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(overridePath, 'utf8'));
    } catch (error) {
      die(`项目覆盖文件 ${OVERRIDE} 不是合法 JSON：${overridePath}（${error.message}）`);
    }
    const { roster, problems } = validateRosterObj(raw, { strict: true });
    if (!roster) die(`项目覆盖文件无效：${overridePath}\n  - ${problems.join('\n  - ')}`);
    const stored = roster;
    return {
      dir,
      key,
      source: 'override',
      overridePath,
      roster: structuredClone(stored),
      stored,
      host: null,
      hostApplied: {},
      workflowName: workflowNameFor(key),
      global: readGlobalSettings(),
    };
  }
  const global = readGlobalSettings();
  if (Object.prototype.hasOwnProperty.call(global.projects, key)) {
    const stored = structuredClone(global.projects[key]);
    return { dir, key, source: 'project', roster: structuredClone(stored), stored, host: null, hostApplied: {}, workflowName: workflowNameFor(key), global };
  }
  const stored = structuredClone(global.default);
  const host = readHostLayer();
  const effective = applyHostLayer(stored, host);
  return { dir, key, source: 'default', roster: effective.roster, stored, host, hostApplied: effective.applied, workflowName: workflowNameFor(key), global };
}

/**
 * 写入前的基线：凡是会落盘的改动都以「来源里的名单」为基准（ctx.stored），
 * 不拿叠加了宿主层的生效名单——宿主层的值任何命令都不写进文件。
 * 代价是写盘后当前作用域变成 project/override，宿主层的覆盖随之失效（符合「只在 global default 生效」）。
 */
function baseRoster(ctx) {
  return structuredClone(ctx.stored);
}

/**
 * 撤销宿主层覆盖：把生效名单里「确实来自宿主层」的项换回来源名单的对应值，得到可落盘的副本。
 * 宿主层只读，自动写入（自愈）不能把它的值当成本项目名单写进文件；非 default 作用域
 * 或宿主层没生效时原样返回。用值相等判定「来自宿主层」——自动流程不会误删用户自己的选择。
 */
function stripHostOverrides(ctx, roster) {
  if (ctx.source !== 'default' || !ctx.hostApplied || Object.keys(ctx.hostApplied).length === 0) return roster;
  const next = structuredClone(roster);
  if (ctx.hostApplied.reworkRounds !== undefined && next.rework_rounds === ctx.hostApplied.reworkRounds) {
    next.rework_rounds = ctx.stored.rework_rounds;
  }
  return next;
}

/**
 * 把名单写回它的来源（覆盖文件 / 全局 projects[键]），并重渲染当前作用域的工作流。
 * default 作用域下的写入不碰全局 default：先物化成本项目专属条目，写进 projects[本项目键]
 * （单项目场景也不能把自己的名单写成所有项目的兜底）。写 project 条目时顺带刷新 default 兜底工作流。
 */
function writeRoster(ctx, roster, quiet = false) {
  if (ctx.source === 'override') {
    writeAtomic(ctx.overridePath, `${JSON.stringify(roster, null, 2)}\n`);
  } else {
    const materialized = ctx.source === 'default';
    const global = { version: 2, default: ctx.global.default, projects: { ...ctx.global.projects } };
    global.projects[ctx.key] = materialized ? structuredClone(roster) : roster;
    writeAtomic(SETTINGS, `${JSON.stringify(global, null, 2)}\n`);
    // 物化后当前作用域就是 project，只渲染本项目工作流一次；default 没变，兜底工作流不必重渲染。
    if (!materialized) render(global.default, true, DEFAULT_WORKFLOW);
    ctx.global = global;
    if (materialized) ctx.source = 'project';
  }
  ctx.stored = structuredClone(roster);
  ctx.roster = structuredClone(roster);
  ctx.hostApplied = {};
  render(roster, quiet, ctx.workflowName);
}

function renderBlock(settings, templateSha, settingsSha) {
  // 插件不再配置模型（模型由宿主「子智能体」决定），模型名单块已废弃；
  // 保留空映射 + 返工轮数，只为让模板结构合法（v2 由主会话直接编排，不读这个块）。
  const rounds = Number.isInteger(settings.rework_rounds) ? settings.rework_rounds : DEFAULTS.rework_rounds;
  return [
    `// @@SWARM_MODELS_BEGIN template=${templateSha} settings=${settingsSha}（由 swarm-config.mjs 生成）`,
    '// 模型由 ZCode 设置 → 子智能体 → ZCode Swarm 决定；本块仅为模板结构保留。',
    'const MODELS: Record<string, ModelRef | undefined> = {};',
    'const MODEL_LABELS: Record<string, string> = {};',
    `const REWORK_ROUNDS = ${rounds};`,
    '// @@SWARM_MODELS_END',
  ].join('\n');
}

/** 一份工作流产物：模板 + 注入后的全文 + 两个戳。渲染与新鲜度判断共用同一份结果，免得两处算法漂移。 */
function workflowArtifact(settings) {
  if (!existsSync(TEMPLATE)) die(`找不到工作流模板：${TEMPLATE}`);
  const template = readFileSync(TEMPLATE, 'utf8');
  if (!BLOCK_RE.test(template)) die(`工作流模板缺少 @@SWARM_MODELS 块：${TEMPLATE}`);
  const templateSha = sha12(template);
  const settingsSha = sha12(JSON.stringify(settings));
  return {
    output: template.replace(BLOCK_RE, renderBlock(settings, templateSha, settingsSha)),
    templateSha,
    settingsSha,
  };
}

function writeWorkflow(name, output, quiet = false) {
  const path = join(WORKFLOWS, `${name}.dwf.ts`);
  writeAtomic(path, output);
  info(`团队工作流已按设置生成：${path}`, quiet);
  return path;
}

export function render(settings, quiet = false, name = DEFAULT_WORKFLOW) {
  return writeWorkflow(name, workflowArtifact(settings).output, quiet);
}

/**
 * 按需重渲染：只有磁盘内容与「当前模板 + 当前名单」的渲染结果逐字节一致才算新鲜。
 * 旧实现只比对模板戳：戳对但正文被截断/改写（部署中断、原地覆盖只盖头部、手改成半截）时
 * 会误判「已是最新」，saved 工作流就带着过期内容一直挂着——部署以 --in-place 就地覆盖后
 * saved 未重渲染正是这类漏网。戳对不上或正文漂移都在这里重写，并把原因打出来（--quiet 时静默落盘）。
 */
function ensureOne(settings, name, quiet) {
  const { output, templateSha, settingsSha } = workflowArtifact(settings);
  const path = join(WORKFLOWS, `${name}.dwf.ts`);
  if (existsSync(path)) {
    const disk = readFileSync(path, 'utf8');
    if (disk === output) return false;
    const head = /@@SWARM_MODELS_BEGIN template=(\w+) settings=(\w+)/.exec(disk);
    const why = !head
      ? '没有模板戳（可能没渲染就直接拷了模板）'
      : head[1] !== templateSha || head[2] !== settingsSha
        ? `模板戳过期（saved template=${head[1]} settings=${head[2]}，应为 template=${templateSha} settings=${settingsSha}）`
        : '模板戳一致但正文有漂移（可能被外部改写或写入不完整）';
    info(`工作流需要重渲染：${path}——${why}`, quiet);
  }
  writeWorkflow(name, output, quiet);
  return true;
}

/**
 * 当前作用域的工作流按需重渲染，并保证旧名兜底工作流（DEFAULT_WORKFLOW）与全局 default 同步。
 * 兜底工作流是部署自检读的那一份，内容只由全局 default 决定、与当前作用域无关：项目/覆盖作用域下
 * 也要刷新它，否则它会在「当前项目有专属名单」的机器上永远停留在旧模板戳（旧分支被 source==='default'
 * 挡住时，--in-place 部署后 saved 不会再被重渲染）。工作流属于部署产物，只按来源名单渲染——
 * 宿主层的值不烘进脚本（它只影响本次解析的输出）。
 */
function ensureFor(ctx, quiet) {
  const rendered = ensureOne(ctx.stored, ctx.workflowName, quiet);
  let refreshedDefault = false;
  if (ctx.workflowName !== DEFAULT_WORKFLOW) {
    refreshedDefault = ensureOne(ctx.global.default, DEFAULT_WORKFLOW, quiet);
  }
  if (!rendered && !refreshedDefault) info('团队工作流已是最新，无需重新生成', quiet);
}

function readInput(args) {
  let raw;
  if (args.stdin) raw = readFileSync(0, 'utf8');
  else if (typeof args.file === 'string') {
    const path = resolve(args.file);
    if (!existsSync(path)) die(`找不到输入文件：${path}`);
    raw = readFileSync(path, 'utf8');
  } else if (typeof args.json === 'string') raw = args.json;
  else die('需要 --stdin、--file <path> 或 --json <字符串>');
  try {
    return JSON.parse(raw);
  } catch (error) {
    return die(`输入不是合法 JSON：${error.message}`);
  }
}

function str(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.trim() : '';
}

/** 与团队工作流同一套写入范围规则：相同或父子包含即重叠，大小写与斜杠方向不敏感。 */
function normalizePath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

function inScope(path, scope) {
  const p = normalizePath(path);
  const s = normalizePath(scope);
  return s.length > 0 && (p === s || p.startsWith(`${s}/`));
}

/**
 * ListModels 的原始文本（或 JSON）→ [{ id, label, levels, defaultLevel, current, disabled }]。
 * 文本行形如：`provider/model — 标签; levels: low,high,max (default max) [current]`。
 */
export function parseModelList(raw) {
  const text = String(raw).replace(/^\uFEFF/, '');
  const trimmed = text.trim();
  const out = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry.id || seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let list;
    try {
      list = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`模型列表不是合法 JSON：${error.message}`);
    }
    for (const item of Array.isArray(list) ? list : list.models ?? []) {
      if (typeof item === 'string') {
        push({ id: item, label: item, levels: [], defaultLevel: '', current: false, disabled: false });
      } else if (item && typeof item.id === 'string') {
        push({
          id: item.id,
          label: typeof item.label === 'string' && item.label ? item.label : item.id,
          levels: Array.isArray(item.levels) ? item.levels.filter((level) => typeof level === 'string') : [],
          defaultLevel: typeof item.defaultLevel === 'string' ? item.defaultLevel : '',
          current: item.current === true,
          disabled: item.disabled === true,
        });
      }
    }
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\S+\/\S+)\s+[—–-]+\s+(.*?)\s*$/.exec(line);
    if (!match) continue;
    const rest = match[2];
    const levels = /levels:\s*([\w,-]+)/.exec(rest);
    const fallback = /\(default\s+([\w-]+)\)/.exec(rest);
    push({
      id: match[1],
      label: rest.split(';')[0].trim() || match[1],
      levels: levels ? levels[1].split(',').filter(Boolean) : [],
      defaultLevel: fallback ? fallback[1] : '',
      current: /\[current\]/.test(rest),
      // levels 里的 disabled 是推理级别（关闭思考），不是模型不可用；只认级别列表之外的标记
      disabled: /\bdisabled\b/.test(rest.replace(/levels:\s*[\w,-]+/, '')),
    });
  }
  return out;
}

/** 读 --models-file，会话供应商取 --session-provider 或标了 [current] 的那行。 */
function readModelList(args) {
  const path = resolve(String(args['models-file']));
  if (!existsSync(path)) die(`找不到模型列表文件：${path}`);
  let list;
  try {
    list = parseModelList(readFileSync(path, 'utf8'));
  } catch (error) {
    return die(error.message);
  }
  if (list.length === 0) die(`模型列表里没解析出任何模型：${path}（应为 ListModels 的原始输出或其 JSON）`);
  const current = list.find((entry) => entry.current);
  const sessionProvider =
    typeof args['session-provider'] === 'string' ? args['session-provider'] : current ? parseModelId(current.id).provider : '';
  return { list, sessionProvider };
}

/** 启动前校验任务卡，返回规范化后的卡（编号转成字符串、补默认角色和档位）。 */
export function checkCards(input) {
  const list = Array.isArray(input) ? input : input && Array.isArray(input.cards) ? input.cards : null;
  if (!list || list.length === 0) return { cards: [], problems: ['需要非空的任务卡数组，或 { "cards": [...] }'] };
  const problems = [];
  const seen = new Set();
  const cards = list.map((entry, index) => {
    const rec = entry && typeof entry === 'object' ? entry : {};
    if (rec !== entry) problems.push(`第 ${index + 1} 张任务卡不是对象`);
    const card = {
      id: str(rec.id) || String(index + 1),
      title: str(rec.title),
      task: str(rec.task),
      scope: str(rec.scope),
      acceptance: str(rec.acceptance),
      role: str(rec.role) || '开发成员',
      model: str(rec.model) || 'strong',
    };
    if (!card.title || !card.task || !card.acceptance) problems.push(`任务卡 ${card.id} 缺少 title、task 或 acceptance`);
    if (seen.has(card.id)) problems.push(`任务卡编号重复：${card.id}`);
    seen.add(card.id);
    return card;
  });
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      const a = cards[i].scope;
      const b = cards[j].scope;
      if (a && b && (inScope(a, b) || inScope(b, a))) {
        problems.push(`任务卡 ${cards[i].id} 与 ${cards[j].id} 的写入范围重叠：${a} / ${b}——会改同一批文件的任务应合并成一张卡`);
      }
    }
  }
  return { cards, problems };
}

function cardTable(cards) {
  const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = ['| 编号 | 任务 | 角色 | 写入范围 | 验收标准 |', '|---|---|---|---|---|'];
  for (const card of cards) {
    lines.push(`| ${cell(card.id)} | ${cell(card.title)} | ${cell(card.role)} | ${cell(card.scope || '未限定')} | ${cell(card.acceptance)} |`);
  }
  return lines.join('\n');
}


function scriptPath() {
  return process.argv[1] ? resolve(process.argv[1]).replace(/\\/g, '/') : '';
}

function scopeLabel(ctx) {
  if (ctx.source === 'override') return `项目覆盖 ${OVERRIDE}（${ctx.dir}）`;
  if (ctx.source === 'project') return `本项目（${ctx.dir}）`;
  const hostNote =
    ctx.hostApplied && Object.keys(ctx.hostApplied).length > 0 ? '；宿主设置层已生效（只读）' : '';
  return `全局默认（${ctx.dir} 未设专属设置${hostNote}）`;
}

/** 展示当前作用域设置：5 个角色的实际模型与来源（宿主设置／继承默认）+ 返工轮数。 */
function showSettings(ctx, asJson) {
  const settings = ctx.roster;
  const agentOverrides = readAgentOverrides();
  // 5 个角色的实际模型与来源：宿主设过的走「宿主设置」，没设的走「继承默认」（跟随主代理）。
  const roles = PLUGIN_ROLES.map((full) => {
    const role = full.replace(/^swarm-/, '');
    const hit = agentOverrides.find((item) => item.role === full);
    return { role, model: hit ? hit.modelId : 'inherit', source: hit ? '宿主设置' : '继承默认' };
  });
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          scope: { dir: ctx.dir, key: ctx.key, source: ctx.source, override: ctx.source === 'override' ? ctx.overridePath : undefined },
          settings,
          roles,
          agentOverrides: agentOverrides.length > 0 ? { file: AGENTS_STATE, roles: agentOverrides } : undefined,
          workflow: ctx.workflowName,
          settingsFile: SETTINGS,
          script: fileURLToPath(import.meta.url),
        },
        null,
        2,
      )}
`,
    );
    return;
  }
  const lines = [
    `zcode-swarm 设置（作用域：${scopeLabel(ctx)}）`,
    `工作流：${ctx.workflowName}`,
    '',
    '团队角色模型（由 ZCode 设置 → 子智能体 → ZCode Swarm 决定，插件不再配置模型）：',
  ];
  for (const item of roles) {
    const label = item.source === '宿主设置' ? item.model : `${item.model}（${INHERIT_LABEL}）`;
    lines.push(`  ${item.role.padEnd(10)} ${label}  ← ${item.source}`);
  }
  const roundsFromHost = ctx.hostApplied && ctx.hostApplied.reworkRounds !== undefined ? ' ← 宿主设置' : '';
  lines.push('', `最多返工轮数：${settings.rework_rounds}${roundsFromHost}`);
  if (ctx.hostApplied && Object.keys(ctx.hostApplied).length > 0) {
    lines.push('', `宿主设置层（${HOST_CONFIG}，只读）覆盖了返工轮数；改这里请走 ZCode 设置界面 → 插件配置。本作用域保存设置后不再受宿主层影响。`);
  }
  lines.push(
    '',
    `要改某个角色的模型：ZCode 设置 → 子智能体 → ZCode Swarm → 该角色。设了就用它；改回「继承默认」就跟随主会话模型。`,
  );
  process.stdout.write(lines.join('\n') + '\n');
}
function saveAndRender(ctx, roster) {
  writeRoster(ctx, roster);
  info(`已保存到${ctx.source === 'override' ? '项目覆盖文件' : ctx.source === 'project' ? '全局 projects[本项目]' : '全局 default'}`);
  showSettings(ctx, false);
}

const commands = {
  show(args) {
    showSettings(loadContext(args), Boolean(args.json));
  },
  /** 插件设置里只剩返工轮数：set 只校验 rework_rounds。 */
  set(args) {
    const ctx = loadContext(args);
    const { roster, problems, ignoredFields } = validateRosterObj(readInput(args), { strict: true });
    if (!roster) die(`设置没有保存：${problems.join('；')}`);
    if (Array.isArray(ignoredFields) && ignoredFields.length > 0) {
      info(`注：旧设置文件里的 ${ignoredFields.join(' / ')} 字段已废弃（模型改由宿主「子智能体」设置决定），保存时已丢弃。`);
    }
    saveAndRender(ctx, roster);
  },
  reset(args) {
    const ctx = loadContext(args);
    writeRoster(ctx, defaultRoster());
    info(`已恢复默认设置（写入${ctx.source === 'override' ? '项目覆盖文件' : '当前作用域'}）`);
    showSettings(ctx, false);
  },
  render(args) {
    const ctx = loadContext(args);
    render(ctx.stored, Boolean(args.quiet), ctx.workflowName);
    // 兜底工作流（旧名）是部署自检读的那一份，与当前作用域无关：项目/覆盖作用域下也一并重建。
    if (ctx.workflowName !== DEFAULT_WORKFLOW) render(ctx.global.default, true, DEFAULT_WORKFLOW);
  },
  ensure(args) {
    ensureFor(loadContext(args), Boolean(args.quiet));
  },
  'check-cards'(args) {
    const ctx = loadContext(args);
    const { cards, problems } = checkCards(readInput(args));
    if (problems.length > 0) die(`任务卡没有通过校验：${problems.join('；')}`);
    if (args.table) process.stdout.write(cardTable(cards) + '\n\n');
    process.stdout.write(`${JSON.stringify(cards, null, 2)}
`);
    info(`${cards.length} 张任务卡校验通过（工作流：${ctx.workflowName}）`);
  },
  /** 拆单后的一次性预校验：只校任务卡（模型由宿主决定，插件不再预检模型）。输出 { cards, workflow }。 */
  validate(args) {
    const ctx = loadContext(args);
    const input = readInput(args);
    const { cards, problems } = checkCards(input);
    if (problems.length > 0) die(`预校验没有通过：${problems.join('；')}`);
    ensureFor(ctx, true); // 工作流是部署产物，顺手保持新鲜（v2 开工不走工作流启动）
    if (args.table) process.stdout.write(cardTable(cards) + '\n\n');
    process.stdout.write(JSON.stringify({ cards, workflow: ctx.workflowName }, null, 2) + '\n');
    info(`${cards.length} 张任务卡校验通过；在 ZCode 里发送 /swarm <需求> 即开工（主会话直接编排）`);
  },

};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const command = commands[args._[0]];
  if (!command) {
    process.stdout.write(`${readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, '')}\n`);
    process.exit(args._[0] ? 2 : 0);
  }
  command(args);
}
