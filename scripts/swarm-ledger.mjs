#!/usr/bin/env node
/**
 * swarm-ledger — zcode-swarm v2 的任务台账（.swarm/ledger.json，唯一事实源）。
 *
 * 台账记录一次团队运行：run_id、需求、任务卡状态、轮次、发现、验证（gate）结果等。
 * 主会话每步推进都写回它；SessionStart 钩子用 recover 检查是否有未完成的运行并提示用户恢复；
 * board 输出 Gen UI 看板数据；report 输出 markdown 施工报告。
 *
 * 台账路径解析（与 swarm-config.mjs 一致）：--project <path> > 环境变量 SWARM_PROJECT > 进程当前目录。
 * 文件固定在 <项目根>/.swarm/ledger.json。所有写入均为原子写（tmp + rename），updated_at 随每次写入刷新。
 *
 * 产物归档：init 时在 <项目根>/.swarm/artifacts/<run_id>/ 建目录，并把相对路径记入台账 artifact_dir。
 * design.md / card-<id>-result.json / card-<id>-review.json / report.md 等产出统一落在这里，
 * 由 artifact 命令读写；update 写 result/review、report 出报告时自动同步归档。
 *
 * 命令：
 *   init --stdin               从 stdin 读 {requirement, cards[], gate, agent_models?, rework_rounds?}
 *                              初始化台账；gate 允许空串（无验证命令），三个可选运行元数据原样存台账顶层
 *   status                     打印台账摘要（每卡一行：#编号[状态]标题）
 *   update <cardId> --stdin    更新指定卡（stdin 传部分字段，深合并；状态转移非法则报错）
 *                             设置 result/review 时自动归档到 card-<id>-result.json / -review.json
 *   artifact <name> [--stdin]  --stdin 把 stdin 原文写入产物；不带 --stdin 则读出产物到 stdout
 *   next                       取下一张 pending 卡并置为 working（stdout 输出完整卡 JSON）
 *   spawn <cardId> --stdin     从指定卡扩编一张新卡追加到 cards（并记入父卡 spawns）
 *   bounce <cardId> --stdin    打回：把追加指令记到目标卡的 bounces（每卡 2 批上限，超限/迟到转 deferred）
 *   finding --stdin            追加一条 finding（输入含 "deferred": true 时记入 deferred）
 *   gate <pass|fail> [rounds]  记录验证结果
 *   fixer --stdin              记录修复员改动
 *   finish <completed|failed>  标记整个运行结束
 *   board                      输出 Gen UI 看板卡片的 JSON 数据
 *   report                     输出完整施工报告的 markdown 文本
 *   render <board|report>      注入数据到 templates/ 的卡片模板，写进 Gen UI 目录；依赖
 *                              ZCODE_GEN_UI_OUTPUT_ROOT 环境变量，并把 ::visualize 行输出到 stderr
 *   recover [--quiet]          检查未完成的团队运行；status=running 时向 stdout 输出恢复提示
 *                              （SessionStart 钩子只捕获 stdout），其余情况静默退出 0（永不报错）。
 *
 * 写命令（init/update/artifact/spawn/bounce/finding/gate/fixer/finish）为单主会话串行调用设计，无并发锁：
 * 并发调用会互相覆盖台账，请勿多进程同时写。
 *
 * 通用选项：--project <path>（项目根，默认取 cwd）。
 * 零依赖，Node 18+。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEDGER_REL = join('.swarm', 'ledger.json');
const ARTIFACTS_REL = join('.swarm', 'artifacts');

/** 产物名前缀/白名单：固定名 + card-<id>-{result,review}.json；其余自定义名限 .md/.json/.txt。 */
const FIXED_ARTIFACT_NAMES = new Set(['design.md', 'report.md']);
const CARD_ARTIFACT_RE = /^card-([^/\\]+)-(result|review)\.json$/;
const CUSTOM_ARTIFACT_RE = /\.(md|json|txt)$/;

/** 不吃值的开关参数。 */
const BOOL_FLAGS = new Set(['stdin', 'quiet']);

/** 卡状态机：pending → working → reviewing → (passed | rework → working → ...) → (passed | failed)。
 *  pending 也可直接 → failed（未启动就作废，例如需求变更）。
 *  rework 只能回 working：主会话必须先把施工员重新派出去，再写 working（两步转移的第二步）。
 *  终态不回头：passed 无出边；failed 唯一出口是 failed → working（主会话接管重做，
 *  例如 builder 死亡后主会话自己重做该卡），必须显式带 {takeover:true} 才放行（无标记仍按终态拒绝，
 *  见 applyCardUpdate）；转移时 round 归零、error 清空、takeover_count +1（供报告披露接管次数）。 */
const CARD_STATES = ['pending', 'working', 'reviewing', 'rework', 'passed', 'failed'];
const ALLOWED_TRANSITIONS = {
  pending: ['working', 'failed'],
  working: ['reviewing', 'failed'],
  reviewing: ['passed', 'rework', 'failed'],
  rework: ['working'],
  passed: [],
  failed: ['working'],
};

/** 台账里需求字段的候选键名（不同写入方可能用不同键，按序取第一个非空）。 */
const REQUIREMENT_KEYS = ['requirement', 'request', '需求'];

/** 卡 id 直接参与归档文件名（card-<id>-result.json），这些字符会破坏路径或跨平台文件名。 */
const UNSAFE_CARD_ID_RE = /[\u0000-\u001f\u007f/\\:*?"<>|]/;
/** 卡 id 长度上限：超出视为异常输入（真实编号不会这么长），也避免文件名过长。 */
const MAX_CARD_ID_LEN = 64;
/** stdin JSON 的嵌套深度上限：防深递归栈溢出（正常卡/结果对象远低于此）。 */
const MAX_JSON_DEPTH = 20;
/** 每张卡最多吸收的打回（bounce）批次数：与 v0.3 起的协议一致（超限转 deferred）。 */
const MAX_BOUNCE_BATCHES = 2;

function die(message, code = 2) {
  console.error(`[swarm-ledger] ERROR: ${message}`);
  process.exit(code);
}

function info(message, quiet = false) {
  if (!quiet) console.error(`[swarm-ledger] ${message}`);
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
    if (BOOL_FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
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

/** 项目根：--project > SWARM_PROJECT > cwd（相对路径基于 cwd 解析）。
 *  空串 / 全空白 / 未展开的 ${...} 占位符都视同未设置（与 swarm-board-server 口径一致）。 */
function projectRoot(args) {
  if (args.project === true) die('--project 需要一个路径值（--project <path>）。');
  const explicit = typeof args.project === 'string' ? args.project : process.env.SWARM_PROJECT;
  if (typeof explicit === 'string' && explicit.trim() && !explicit.includes('${')) {
    return isAbsolute(explicit.trim()) ? explicit.trim() : resolve(process.cwd(), explicit.trim());
  }
  return process.cwd();
}

function ledgerPath(args) {
  return join(projectRoot(args), LEDGER_REL);
}

/* ------------------------------ 通用小工具 ------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

/** 时间戳式 run_id：run-YYYYMMDD-HHMMSS-随机4位。 */
function makeRunId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const rnd = Math.random().toString(36).slice(2, 6);
  return `run-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rnd}`;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 这些键无论如何不能从 stdin 合并进台账：__proto__ / constructor / prototype 是原型污染链的入口。 */
function isReservedKey(k) {
  return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

/**
 * run_id 消毒：run_id 会拼进产物目录与可视化文件名，只保留白名单字符。
 * 台账可能被手改成 ../../evil，任何写/读路径前都必须过这一道。
 */
function sanitizeRunId(value) {
  const s = typeof value === 'string' ? value.replace(/[^A-Za-z0-9_-]/g, '') : '';
  return s || 'run-unknown';
}

/** 卡 id 校验：id 参与归档文件名 card-<id>-result.json，禁止路径分隔符/控制字符/超长。 */
function assertCardId(id, where) {
  const t = typeof id;
  if (t !== 'string' && t !== 'number') {
    die(`${where}卡 id 必须是字符串或数字，实际是 ${isPlainObject(id) ? '对象' : t}。`);
  }
  const s = String(id);
  if (!s.trim() || s.length > MAX_CARD_ID_LEN || UNSAFE_CARD_ID_RE.test(s)) {
    die(`${where}卡 id 非法（${JSON.stringify(s)}）：不能为空、不能超过 ${MAX_CARD_ID_LEN} 字符，且不能含路径分隔符、控制字符或 Windows 保留字符。`);
  }
  return s;
}

/**
 * 深拷贝 stdin/台账里的 JSON 值，同时剥掉 __proto__ / constructor / prototype 键。
 * JSON.parse 自身不会改原型（这些键是自有属性），但把它们原样写回台账会把污染载荷留存下来，
 * 后续任何不设防的消费方都可能中招；所以入口统一净化。
 */
function cloneSafe(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) die(`JSON 嵌套层级过深（超过 ${MAX_JSON_DEPTH} 层），拒绝写入台账。`);
  if (Array.isArray(value)) return value.map((v) => cloneSafe(v, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!isReservedKey(k)) out[k] = cloneSafe(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** 台账数组字段的安全读取：不是数组（手改坏了/老格式）就当空数组，永不 TypeError。 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 台账数组字段的安全写入：不是数组就先换成空数组（老台账/手改台账缺字段或类型错）。 */
function ensureArrayField(ledger, key) {
  if (!Array.isArray(ledger[key])) ledger[key] = [];
  return ledger[key];
}

/** 非负整数判定（round / gate_rounds / rework_rounds 共用）。 */
function isCount(v) {
  return Number.isInteger(v) && v >= 0;
}

/** 轮次数字兜底：手改台账里写成 "2" 也能按 2 处理，脏值按 0。 */
function countOf(v) {
  if (isCount(v)) return v;
  const n = Number(v);
  return isCount(n) ? n : 0;
}

/** 分诊条目文本：字符串原样；对象按 text/title/summary/changes 取；其余 JSON 化兜底。 */
function entryText(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string') return entry;
  if (isPlainObject(entry)) {
    const v = entry.text ?? entry.title ?? entry.summary ?? entry.changes;
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v)) {
      const joined = v.map((item) => (typeof item === 'string' ? item : safeJson(item))).filter(Boolean).join('；');
      if (joined.trim()) return joined;
    }
    return safeJson(entry);
  }
  return String(entry);
}

/** 深合并：对象递归，数组与标量整体替换；null 覆盖旧值（用于清空 result/review 等）。 */
function deepMerge(target, patch, depth = 0) {
  if (depth > MAX_JSON_DEPTH) die(`更新的嵌套层级过深（超过 ${MAX_JSON_DEPTH} 层），拒绝合并。`);
  for (const [k, v] of Object.entries(patch)) {
    // 防原型污染：stdin 里塞 __proto__ / constructor / prototype 会顺着递归改写 Object.prototype。
    if (isReservedKey(k)) continue;
    if (isPlainObject(v) && isPlainObject(target[k])) deepMerge(target[k], v, depth + 1);
    else target[k] = v;
  }
  return target;
}

function clip(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}

/** 取结果的一行摘要：字符串取首行；对象优先 summary，否则 JSON 化。 */
function resultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result.split(/\r?\n/)[0];
  if (isPlainObject(result)) {
    if (typeof result.summary === 'string') return result.summary;
    try {
      return JSON.stringify(result);
    } catch {
      return '';
    }
  }
  return String(result);
}

/** markdown 单元格净化：剥控制字符、去换行（会断表）、转义竖线。 */
function mdEscape(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\|/g, '\\|');
}

/** gate 展示：空 gate 是合法值（项目无验证命令），显示占位文案，别输出空反引号。 */
function gateLabel(gate) {
  return typeof gate === 'string' && gate.trim() ? `\`${gate}\`` : '（无验证命令）';
}

/** 人性化耗时：2h05m / 3m12s / 45s / n/a。 */
function fmtElapsed(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'n/a';
  const total = Math.max(0, Math.floor((b - a) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/* ------------------------------ 台账读写 ------------------------------ */

/**
 * 旧台账自洁：三大档模型概念已随插件移除，cards[].model 是已废弃的档位字段。
 * 读取时在内存对象层静默剥离（不主动重写磁盘）——下一次本来就要写的命令顺手让它消失。
 * 只动卡片对象自身的 model 键，不碰其他字段与状态机；cards 非数组/条目非对象时原样放过。
 */
function stripLegacyCardFields(ledger) {
  for (const card of asArray(ledger.cards)) {
    if (isPlainObject(card) && Object.prototype.hasOwnProperty.call(card, 'model')) delete card.model;
  }
  return ledger;
}

/** 读台账；不存在返回 null；内容损坏时提示并返回 null（不阻断调用方，recover 用）。 */
function readLedger(args, quiet) {
  const path = ledgerPath(args);
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    info(`台账不可读（${path}）：${err.message}`, quiet);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    // 台账顶层必须是对象：数组/标量一律视为损坏（否则下游按对象访问会诡异失败）。
    return isPlainObject(parsed) ? stripLegacyCardFields(parsed) : null;
  } catch {
    info(`台账不是合法 JSON（${path}），忽略。`, quiet);
    return null;
  }
}

/** 严格读台账（新命令用）：缺失/损坏直接报错退出。 */
function loadStrict(args) {
  const path = ledgerPath(args);
  const ledger = readLedger(args, false);
  if (!ledger) die(`台账不存在或损坏（${path}）。请先在项目目录执行 init --stdin，或用 --project 指定正确项目根。`);
  if (!Array.isArray(ledger.cards)) die('台账结构不完整（缺少 cards 数组），拒绝操作。');
  return ledger;
}

/** 原子写：先写同目录 tmp，再 rename 覆盖；updated_at 每次都刷新。 */
function atomicSave(args, ledger) {
  const path = ledgerPath(args);
  ledger.updated_at = nowIso();
  // 台账目录不存在就先建出来，保证 tmp 与目标同目录
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  } catch (err) {
    // 写 tmp 就失败说明磁盘/权限有问题，清理半截 tmp 再报错（与 rename 失败分支对齐）。
    try {
      unlinkSync(tmp);
    } catch {
      /* 没写成功往往也没 tmp，清理失败不盖住原始错误 */
    }
    die(`台账写入失败（${path}）：${err.message}`);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败就算了，别盖住原始错误 */
    }
    die(`台账写入失败（${path}）：${err.message}`);
  }
}

/* ------------------------------ 产物归档 ------------------------------ */

/** 路径统一成 / 分隔写入台账，跨平台可读（Windows 的 resolve 也认 /）。 */
function toPosixPath(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * 路径是否落在 root 之内（含 root 自身）。Windows 大小写不敏感，比较前统一小写；
 * 台账里的 artifact_dir 可能被手改，越界一律不认。
 */
function isInsidePath(childAbs, rootAbs) {
  const child = resolve(childAbs);
  const root = resolve(rootAbs);
  const a = process.platform === 'win32' ? child.toLowerCase() : child;
  const b = process.platform === 'win32' ? root.toLowerCase() : root;
  return a === b || a.startsWith(`${b}${sep}`);
}

/** 本次运行的产物目录：台账 artifact_dir 优先，旧台账按 run_id 推导；相对路径基于项目根。
 *  artifact_dir 也来自台账（可能被手改），解析结果必须仍在项目根之内，否则退回按 run_id 推导的目录。 */
function artifactDirOf(args, ledger) {
  const root = resolve(projectRoot(args));
  const stored = typeof ledger.artifact_dir === 'string' && ledger.artifact_dir.trim() ? ledger.artifact_dir.trim() : '';
  const fallback = resolve(root, toPosixPath(join(ARTIFACTS_REL, sanitizeRunId(ledger.run_id))));
  if (!stored) return fallback;
  const abs = isAbsolute(stored) ? stored : resolve(root, stored);
  if (isInsidePath(abs, root)) return abs;
  info(`台账 artifact_dir 越出项目根（${stored}），改用 run_id 推导目录。`);
  return fallback;
}

/** 校验产物名：固定名 / card-<id>-{result,review}.json / 自定义 .md .json .txt；禁止路径穿越。 */
function checkArtifactName(name) {
  if (name == null || !String(name).trim()) {
    die('artifact 需要产物名，如 design.md、card-1-result.json、card-1-review.json、report.md。');
  }
  const n = String(name).trim();
  if (n.includes('..') || n.includes('/') || n.includes('\\') || /[\u0000-\u001f:*?"<>|]/.test(n)) {
    die(`产物名 "${n}" 非法：只允许文件名，不能含路径分隔符、控制字符或 Windows 保留字符。`);
  }
  if (FIXED_ARTIFACT_NAMES.has(n) || CARD_ARTIFACT_RE.test(n) || CUSTOM_ARTIFACT_RE.test(n)) return n;
  die(`产物名 "${n}" 不受支持：允许 design.md、report.md、card-<id>-result.json、card-<id>-review.json，或扩展名为 .md/.json/.txt 的自定义名。`);
}

/** 原子写产物：tmp + rename，父目录自动创建；fatal=false 时失败只告警不退出。 */
function writeArtifactFile(path, content, fatal = true) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(tmp, content, 'utf8');
    } catch (err) {
      // 写 tmp 就失败（磁盘满、无权限）时先把半截 tmp 清掉再抛，避免残留文件。
      try {
        unlinkSync(tmp);
      } catch {
        /* 没有 tmp 或清理失败都不盖住原始错误 */
      }
      throw err;
    }
    try {
      renameSync(tmp, path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* 清理失败就算了，别盖住原始错误 */
      }
      throw err;
    }
  } catch (err) {
    if (fatal) die(`产物写入失败（${path}）：${err.message}`);
    info(`产物写入失败（${path}）：${err.message}`);
  }
}

/** 读产物；不存在返回 null。 */
function readArtifactFile(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    die(`产物不可读（${path}）：${err.message}`);
  }
}

/** 把某个字段的 JSON 快照归档为 card-<id>-<kind>.json；值为 null 时删除旧归档。
 *  card.id 来自台账（可能被手改），拼文件名前先过 assertCardId，杜绝路径穿越。
 *  fatal=false 时产物写入失败只告警（台账已落盘，不能因为归档失败让调用方误判 update 失败）。 */
function archiveCardField(args, ledger, card, kind, value, fatal = true) {
  const safeId = assertCardId(card.id, '归档');
  const name = `card-${safeId}-${kind}.json`;
  const path = join(artifactDirOf(args, ledger), name);
  if (value == null) {
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch (err) {
        info(`旧归档清理失败（${path}）：${err.message}`);
      }
    }
    return;
  }
  let body;
  try {
    body = JSON.stringify(value, null, 2);
  } catch (err) {
    die(`卡 #${card.id} 的 ${kind} 无法序列化为 JSON：${err.message}`);
  }
  writeArtifactFile(path, `${body}\n`, fatal);
  info(`已归档产物 ${name}（${path}）。`);
}

/* ------------------------------ stdin ------------------------------ */

function readStdinJson(what) {
  if (process.stdin.isTTY) {
    die(`${what} 需要从 stdin 读 JSON。示例：echo '{"...": ...}' | node swarm-ledger.mjs <命令> --stdin`);
  }
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch (err) {
    die(`读取 stdin 失败：${err.message}`);
  }
  if (!raw.trim()) die(`stdin 为空，无法解析 JSON（${what}）。`);
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) die(`stdin JSON 必须是对象（${what}）。`);
    return parsed;
  } catch (err) {
    die(`stdin 不是合法 JSON（${what}）：${err.message}`);
  }
}

/** 逐字节读 stdin 原文（artifact 用，不解析 JSON）。 */
function readStdinRaw(what) {
  if (process.stdin.isTTY) die(`${what} 需要从 stdin 读内容。示例：cat design.md | node swarm-ledger.mjs artifact design.md --stdin`);
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    die(`读取 stdin 失败：${err.message}`);
  }
}

/* ------------------------------ 卡操作 ------------------------------ */

/** 卡展示字段强制成字符串：对象/数组/null 一律回落默认值，别渲染成 [object Object] 或 "null"。 */
function textField(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/** 规整一张卡的完整字段（init / spawn 用，缺省值兜底）。
 *  result/review 走 cloneSafe：剥掉 __proto__/constructor/prototype 后再落账。
 *  launched_at/completed_at 只接受字符串时间戳：脏值置 null，避免报告里输出 [object Object]。 */
function normalizeCard(input, id) {
  const src = isPlainObject(input) ? input : {};
  return {
    id: String(id),
    title: textField(src.title) || textField(src.task) || '未命名任务',
    task: textField(src.task) || textField(src.title),
    scope: textField(src.scope),
    acceptance: textField(src.acceptance),
    role: textField(src.role) || 'worker',
    // builder 的宿主 agent-id（可选，字符串）：主会话派工后落账，供收卡主动轮询（TaskOutput 查询）用。
    agent_id: textField(src.agent_id) || undefined,
    // init / spawn 的新卡一律从 pending、round 0 起步：状态与轮次只能经 update 的状态机推进。
    state: 'pending',
    round: 0,
    result: src.result == null ? null : cloneSafe(src.result),
    review: src.review == null ? null : cloneSafe(src.review),
    spawns: asArray(src.spawns),
    // 打回（bounce）批次：属于在跑卡自身的追加指令，主会话用 bounce 命令落账。
    bounces: asArray(src.bounces),
    error: src.error == null ? null : entryText(src.error),
    launched_at: typeof src.launched_at === 'string' ? src.launched_at : null,
    completed_at: typeof src.completed_at === 'string' ? src.completed_at : null,
  };
}

function findCard(ledger, cardId) {
  const id = assertCardId(cardId, '');
  const card = cardList(ledger).find((c) => String(c.id) === id);
  if (!card) {
    const have = cardList(ledger).map((c) => `#${c.id}`).join(' ') || '无';
    die(`卡 #${id} 不存在。现有卡：${have}`);
  }
  return card;
}

function nextCardId(ledger) {
  let max = 0;
  for (const c of cardList(ledger)) {
    const n = Number(c.id);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return String(max + 1);
}

/**
 * 把补丁应用到卡上：深合并 + 状态转移校验 + 时间戳/轮次副作用。
 * - 进入 working：launched_at 只在为空时补；进入 working/reviewing 时清上一轮 error
 * - 进入 passed/failed：缺省时补 completed_at（已有时不覆盖）
 * - reviewing → rework：round + 1（轮次只由状态机维护，显式 round 被忽略）
 * - reviewing → rework 且 round 将超过 rework_rounds 上限：拒绝（主会话应写 failed）
 * - failed → working（主会话接管重做）：须显式带 {takeover:true}；round 归零、takeover_count +1（只由状态机维护）
 * - 状态未变（同态 update）时不做转移副作用，只合并字段
 */
function applyCardUpdate(card, patch, ledger) {
  if ('id' in patch && String(patch.id) !== String(card.id)) {
    die(`不允许修改卡 id（#${card.id} → #${patch.id}）。`);
  }
  delete patch.id;

  // agent_id 只收非空字符串（builder 宿主 id，供主动轮询）；脏值忽略。
  if ('agent_id' in patch && typeof patch.agent_id !== 'string') {
    info(`卡 #${card.id} 的 agent_id 值非法（应为非空字符串），已忽略该字段。`);
    delete patch.agent_id;
  }
  // agent_id 存在性验证（2026-11-22 jjda 事故根因）：长会话上下文压缩时宿主会静默丢弃
  // Agent.spawn 调用但返回假 agent_id——台账写着 working 但子代理从未创建。
  // 进入 working 状态时若 patch 含 agent_id，必须能在 ~/.zcode/cli/agents/ 下找到对应目录，
  // 找不到就拒绝写入并诊断原因（主会话应重新 spawn 或处理）。
  const newState = patch.state != null ? String(patch.state) : card.state;
  if (newState === 'working' && typeof patch.agent_id === 'string' && patch.agent_id.trim()) {
    const aid = patch.agent_id.trim();
    const agentsRoot = join(homedir(), '.zcode', 'cli', 'agents');
    let found = false;
    if (existsSync(agentsRoot)) {
      try {
        for (const sess of readdirSync(agentsRoot)) {
          if (existsSync(join(agentsRoot, sess, aid, 'metadata.json'))) { found = true; break; }
        }
      } catch { /* 目录读失败不阻塞 */ }
    }
    if (!found) {
      die(`agent_id "${aid}" 在宿主中不存在（找不到 ~/.zcode/cli/agents/*/${aid}/metadata.json）。这通常发生在长会话上下文压缩时 Agent.spawn 被静默丢弃——主会话的 spawn 返回了假 id。请重新 spawn 该卡 builder，确认返回真实 agent_id 后再写入 working。`);
    }
  }

  // round 只接受非负整数：显式传脏值（"abc"/-1/1.5）时丢弃该字段（退回原值），别把已有轮次洗成 0。
  if ('round' in patch && !isCount(patch.round)) {
    info(`卡 #${card.id} 的 round 值非法（${JSON.stringify(patch.round)}），已忽略该字段。`);
    delete patch.round;
  }
  const cur = card.state;
  const next = patch.state != null ? String(patch.state) : cur;
  if (!CARD_STATES.includes(next)) die(`非法状态 "${next}"（合法值：${CARD_STATES.join(' | ')}）。`);
  if (!CARD_STATES.includes(cur)) {
    die(`卡 #${card.id} 当前状态非法（${JSON.stringify(cur)}），拒绝转移。请先把台账里该卡 state 修成 ${CARD_STATES.join(' / ')} 之一，或用 --project 指向正确台账。`);
  }
  // failed → working 是唯一的终态出口（主会话接管重做）：必须显式带 {takeover:true}，
  // 无标记仍按终态拒绝，防止误把 failed 洗回在途。
  if (cur === 'failed' && next === 'working' && patch.takeover !== true) {
    die(`非法状态转移：卡 #${card.id} failed → working 需主会话接管重做：请在补丁里显式携带 {"takeover":true}（无标记不接受，防误把终态洗回在途）。`);
  }
  if (next !== cur && !(cur === 'failed' && next === 'working')) {
    const allowed = ALLOWED_TRANSITIONS[cur] ?? [];
    if (!allowed.includes(next)) {
      die(`非法状态转移：卡 #${card.id} ${cur} → ${next}（允许：${allowed.map((s) => `${cur} → ${s}`).join('、') || '无（终态）'}）。`);
    }
  }
  // takeover 标记只用于解锁上面这条转移，不落卡；卡上以 takeover_count 披露接管次数。
  delete patch.takeover;

  // 返工计数只能由状态机维护：显式传 round 会被忽略，防止「reviewing → rework 时手写 round」绕过上限或把轮次拨回去。
  if (cur === 'reviewing' && next === 'rework') {
    if ('round' in patch) {
      info(`卡 #${card.id} 的 reviewing → rework 由状态机计轮次，忽略显式 round=${JSON.stringify(patch.round)}。`);
      delete patch.round;
    }
    const cap = reworkCapOf(ledger);
    const newRound = countOf(card.round) + 1;
    // 上限 N 表示最多允许 N 轮（round 1..N）；已到上限时拒绝再进 rework，主会话应按协议写 failed。
    if (cap != null && newRound > cap) {
      die(`卡 #${card.id} 已达返工上限（本轮将是第 ${newRound} 轮，rework_rounds=${cap}）：不能再进 rework，请直接写 {"state":"failed"} 并附 review/error。`);
    }
  }

  // 接管重做（failed → working）的状态机副作用：round 归零、takeover_count +1
  // （error 由下方 working 入口的通用清理负责）。round/takeover_count 都由状态机维护：
  // 补丁里显式传的这两个字段一律忽略，防止洗数。
  if (cur === 'failed' && next === 'working') {
    for (const key of ['round', 'takeover_count']) {
      if (key in patch) {
        info(`卡 #${card.id} 的 failed → working 由状态机维护 ${key}，忽略显式 ${key}=${JSON.stringify(patch[key])}。`);
        delete patch[key];
      }
    }
    card.round = 0;
    card.takeover_count = countOf(card.takeover_count) + 1;
  }

  const now = nowIso();
  if (next === 'working' && card.launched_at == null && !('launched_at' in patch)) card.launched_at = now;
  // 进入非终态（working/reviewing）时清掉上一轮遗留的错误标记，除非本次补丁显式带 error：
  // 否则返工成功后看板/报告仍会显示上一轮的 ERROR 摘要。
  if (next !== cur && (next === 'working' || next === 'reviewing') && !('error' in patch)) card.error = null;
  // completed_at 只在缺省时补：重复写 passed/failed 不能把完成时间刷新掉；
  // 手修台账缺 completed_at 时，同态补写一次也能补上（不会覆盖已有值）。
  if ((next === 'passed' || next === 'failed') && !('completed_at' in patch) && card.completed_at == null) {
    card.completed_at = now;
  }
  if (cur === 'reviewing' && next === 'rework') card.round = countOf(card.round) + 1;

  deepMerge(card, patch);
  card.state = next;
  // round 永远规整成非负整数：stdin 可能写进字符串/负数，靠这个兜底。
  card.round = countOf(card.round);
  // spawns 必须是数组（报告/看板会直接遍历；手改台账可能写成字符串）。
  if (!Array.isArray(card.spawns)) card.spawns = [];
}

/** 台账返工上限：init 的 rework_rounds 是可选元数据，缺省（老台账）视为不限（null）。
 *  手改成字符串 "2" 也认；写坏（"abc"/负数/小数）则按不限处理，绝不悄悄变成「上限 0」。 */
function reworkCapOf(ledger) {
  const raw = ledger.rework_rounds;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 数组条目下一个 id：取现有最大数字 id + 1（勿用 length+1，删除/手改后会撞号）。 */
function nextEntryId(list, fallback) {
  let max = 0;
  for (const item of asArray(list)) {
    const n = Number(isPlainObject(item) ? item.id : NaN);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max > 0 ? max + 1 : fallback;
}

/* ------------------------------ 命令实现 ------------------------------ */

function cmdInit(args) {
  const path = ledgerPath(args);
  const prev = readLedger(args, true);
  if (prev && prev.status === 'running') {
    die(`台账已存在且正在运行（${prev.run_id ?? '未知 run_id'}，${path}）。请先 finish <completed|failed> 结束该运行，或删除/归档旧台账后再 init。`);
  }

  const input = readStdinJson('init');
  if (typeof input.requirement !== 'string' || !input.requirement.trim()) die('init 输入缺少 requirement（需求原文）。');
  if (!Array.isArray(input.cards) || input.cards.length === 0) die('init 输入缺少 cards[]（至少一张任务卡）。');
  // gate 字段必须给出，但允许空串/纯空白：协议允许没有验证命令的项目（trim 后存空串）。
  if (typeof input.gate !== 'string') die('init 输入缺少 gate（验证命令；没有验证命令请传空串 ""）。');

  const seen = new Set();
  const cards = input.cards.map((c, i) => {
    if (!isPlainObject(c)) die(`init 第 ${i + 1} 张任务卡不是对象，拒绝初始化。`);
    const id = assertCardId(c.id != null ? c.id : i + 1, 'init ');
    if (seen.has(id)) die(`init 卡 id 重复：#${id}。`);
    seen.add(id);
    return normalizeCard(c, id);
  });

  const now = nowIso();
  const runId = makeRunId();
  const artifactRel = toPosixPath(join(ARTIFACTS_REL, runId));
  const artifactAbs = resolve(projectRoot(args), artifactRel);

  const ledger = {
    version: 1,
    run_id: runId,
    artifact_dir: artifactRel,
    requirement: input.requirement,
    gate: input.gate.trim(),
    created_at: now,
    updated_at: now,
    status: 'running',
    cards,
    findings: [],
    deferred: [],
    gate_status: null,
    gate_rounds: 0,
    fixer_changes: [],
  };

  // 运行元数据（可选）：类型不符就忽略并提醒，不 die（不该因为展示字段挡住启动）。
  // agent_models：本次运行每个角色实际用的模型与来源（宿主设置 / 继承默认）——只用于报告展示。
  if (input.agent_models !== undefined) {
    if (isPlainObject(input.agent_models)) ledger.agent_models = cloneSafe(input.agent_models);
    else info('init 输入 agent_models 不是对象，已忽略。');
  }
  if (input.rework_rounds !== undefined) {
    // 上限必须是非负整数：NaN/Infinity/负数/小数都拒绝，否则状态机上限判定会失真。
    if (isCount(input.rework_rounds)) ledger.rework_rounds = input.rework_rounds;
    else info('init 输入 rework_rounds 不是非负整数，已忽略。');
  }

  // 先建目录再落账：目录建不出来就干脆别初始化，避免台账指向不存在的归档区。
  try {
    mkdirSync(artifactAbs, { recursive: true });
  } catch (err) {
    die(`产物目录创建失败（${artifactAbs}）：${err.message}`);
  }

  // 旧台账（已结束）先完整归档到 artifacts/<旧run_id>/ledger-final.json，再覆盖，避免丢失复盘材料。
  if (prev) {
    // 旧 run_id 也可能被篡改成 ../../evil，统一走 sanitizeRunId 后再拼路径。
    const prevRunId = sanitizeRunId(prev.run_id);
    const archiveRel = toPosixPath(join(ARTIFACTS_REL, prevRunId));
    const archiveAbs = resolve(projectRoot(args), archiveRel);
    let prevBody;
    try {
      prevBody = `${JSON.stringify(prev, null, 2)}\n`;
    } catch (err) {
      info(`旧台账序列化失败（${prevRunId}），跳过归档：${err.message}`);
      prevBody = null;
    }
    if (prevBody != null) {
      writeArtifactFile(join(archiveAbs, 'ledger-final.json'), prevBody, false);
      info(`旧台账已归档到 ${toPosixPath(join(archiveRel, 'ledger-final.json'))}。`);
    }
  }

  atomicSave(args, ledger);
  console.log(`已初始化台账 ${path}`);
  console.log(`run_id=${ledger.run_id} 卡数=${ledger.cards.length} gate=${gateLabel(ledger.gate)}`);
  console.log(`产物目录=${artifactRel}`);
  return 0;
}

function cmdStatus(args) {
  const l = loadStrict(args);
  console.log(`蜂群台账 ${displayRunId(l)} [${l.status ?? '?'}]`);
  console.log(`需求: ${requirementText(l) || '-'}`);
  const gate = typeof l.gate === 'string' && l.gate.trim() ? l.gate : '（无）';
  const gateState = l.gate_status == null ? '未运行' : String(l.gate_status);
  console.log(`Gate: ${gate} | ${gateState}（第 ${countOf(l.gate_rounds)} 轮）`);
  for (const c of cardList(l)) console.log(`  #${c.id}[${c.state ?? '?'}] ${c.title ?? ''}`);
  console.log(
    `Findings: ${asArray(l.findings).length} | Deferred: ${asArray(l.deferred).length} | 修复记录: ${asArray(l.fixer_changes).length} | 更新于 ${l.updated_at ?? '-'}`
  );
  return 0;
}

function cmdUpdate(args) {
  const cardId = args._[0];
  if (cardId == null) die('用法: swarm-ledger update <cardId> --stdin');
  if (args.stdin !== true) die('update 需要 --stdin（stdin 传要合并的字段，如 {"state":"reviewing","result":...}）。');
  // stdin 先净化：__proto__/constructor/prototype 键在入口就丢掉，绝不进台账。
  const patch = cloneSafe(readStdinJson(`update 卡 #${cardId}`));
  const ledger = loadStrict(args);
  const card = findCard(ledger, cardId);
  // 要归档的卡 id 必须在落盘前校验：否则 assertCardId 在归档阶段失败时，台账已被写成新状态。
  if ('result' in patch || 'review' in patch) assertCardId(card.id, '归档');
  applyCardUpdate(card, patch, ledger);
  // 台账先落盘再归档；归档失败只告警（台账已是事实源，不能让调用方误以为 update 失败而重试）
  atomicSave(args, ledger);
  if ('result' in patch) archiveCardField(args, ledger, card, 'result', card.result, false);
  if ('review' in patch) archiveCardField(args, ledger, card, 'review', card.review, false);
  info(`卡 #${card.id} 已更新（state=${card.state} round=${card.round}）。`);
  console.log(JSON.stringify(card, null, 2));
  return 0;
}

function cmdArtifact(args) {
  const name = checkArtifactName(args._[0]);
  const ledger = loadStrict(args);
  const path = join(artifactDirOf(args, ledger), name);
  if (args.stdin === true) {
    const content = readStdinRaw(`artifact ${name}`);
    writeArtifactFile(path, content);
    info(`已写入产物 ${name}（${path}，${content.length} 字符）。`);
    return 0;
  }
  const content = readArtifactFile(path);
  if (content == null) die(`产物 ${name} 不存在（${path}）。先写入：cat <文件> | node swarm-ledger.mjs artifact ${name} --stdin`);
  process.stdout.write(content);
  return 0;
}

function cmdNext(args) {
  const ledger = loadStrict(args);
  if (ledger.status !== 'running') {
    die(`台账状态为 ${ledger.status}，next 仅在 running 时可用。`);
  }
  const card = cardList(ledger).find((c) => c.state === 'pending');
  if (!card) {
    info(`没有待处理（pending）的卡。当前：${cardList(ledger).map((c) => `#${c.id}[${c.state}]`).join(' ') || '无'}`);
    return 1;
  }
  applyCardUpdate(card, { state: 'working' }, ledger);
  atomicSave(args, ledger);
  info(`卡 #${card.id} 已置为 working。`);
  console.log(JSON.stringify(card, null, 2));
  return 0;
}

function cmdSpawn(args) {
  const parentId = args._[0];
  if (parentId == null) die('用法: swarm-ledger spawn <cardId> --stdin（cardId 为扩编来源的父卡）。');
  if (args.stdin !== true) die('spawn 需要 --stdin（stdin 传新卡字段，如 {"title":...,"task":...}）。');
  const input = cloneSafe(readStdinJson(`spawn 自卡 #${parentId}`));
  const ledger = loadStrict(args);
  if (ledger.status !== 'running') die(`台账状态为 ${ledger.status}，spawn 仅在 running 时可用。`);
  if (!input.title && !input.task) die('spawn 卡缺少 title 或 task。');

  const parent = findCard(ledger, parentId);
  let id;
  if (input.id != null) {
    id = assertCardId(input.id, 'spawn ');
    if (cardList(ledger).some((c) => String(c.id) === id)) die(`卡 #${id} 已存在，spawn 的 id 不能与现有卡重复。`);
  } else {
    id = nextCardId(ledger);
  }
  // 新卡只取卡字段白名单，不把任意 stdin 键（如 state/round/launched_at）带进来：
  // 新卡一律 pending、round 0，状态只能经 update 的状态机推进。
  const card = normalizeCard(input, id);
  if (!Array.isArray(ledger.cards)) ledger.cards = [];
  ledger.cards.push(card);
  if (!Array.isArray(parent.spawns)) parent.spawns = [];
  parent.spawns.push(card.id);
  atomicSave(args, ledger);
  info(`卡 #${card.id}「${card.title}」已扩编（来源 #${parent.id}）。`);
  console.log(JSON.stringify(card, null, 2));
  return 0;
}

function cmdFinding(args) {
  if (args.stdin !== true) die('finding 需要 --stdin（stdin 传 {"text":...,"card_id":...}；含 "deferred": true 记入遗留项）。');
  const input = cloneSafe(readStdinJson('finding'));
  const ledger = loadStrict(args);
  // 老台账/手改台账可能缺这些数组或类型不对，先规整成数组再操作，避免 TypeError。
  const findings = ensureArrayField(ledger, 'findings');
  const deferred = ensureArrayField(ledger, 'deferred');
  ensureArrayField(ledger, 'fixer_changes');
  const text = input.text ?? input.title ?? input.summary;
  if (text == null || String(text).trim() === '') die('finding 缺少 text/title/summary 描述。');
  // 引用卡号时校验格式（卡号会进报告文本与归档名，禁止路径字符/控制字符）。
  if (input.card_id != null) assertCardId(input.card_id, 'finding ');

  const entry = input; // 已在入口 cloneSafe 净化
  const isDeferred = entry.deferred === true;
  delete entry.deferred;
  entry.id = entry.id ?? nextEntryId(isDeferred ? deferred : findings, (isDeferred ? deferred.length : findings.length) + 1);
  entry.created_at = entry.created_at ?? nowIso();

  if (isDeferred) {
    deferred.push(entry);
    info(`已记录遗留项 #${entry.id}（deferred，共 ${deferred.length} 条）。`);
  } else {
    findings.push(entry);
    info(`已记录 finding #${entry.id}（共 ${findings.length} 条）。`);
  }
  atomicSave(args, ledger);
  console.log(JSON.stringify(entry, null, 2));
  return 0;
}

function cmdGate(args) {
  const result = args._[0];
  if (result !== 'pass' && result !== 'fail') die('用法: swarm-ledger gate <pass|fail> [rounds]（rounds 缺省为当前轮数 +1）。');
  const ledger = loadStrict(args);
  // 硬闸（S2）：gate 只在每张卡都到终态后才有意义——未终态时放行会让报告渲染出
  // 「0/N 通过」的假失败（2026-11-21 事故：5 张 reviewing 漏收直接 gate pass + finish）。
  const unsettled = cardList(ledger).filter((c) => !['passed', 'failed'].includes(c.state));
  if (unsettled.length > 0) {
    die(`还有 ${unsettled.length} 张卡未到终态，不能记录验证结果：${unsettled.map((c) => `#${c.id}[${c.state}]`).join(' ')}。先逐卡收卡（reviewing → passed/failed），或确认这些卡确已死亡后写 failed。`);
  }
  let rounds;
  if (args._[1] !== undefined) {
    rounds = Number(args._[1]);
    if (!Number.isInteger(rounds) || rounds < 0) die('gate 轮次必须是非负整数。');
  } else {
    rounds = countOf(ledger.gate_rounds) + 1;
  }
  // 修复轮上限 = 台账 rework_rounds：达到上限还在 fail 时提醒主会话收尾（仍允许记录，别卡死收尾流程）。
  if (result === 'fail') {
    const cap = reworkCapOf(ledger);
    if (cap != null && rounds > cap) {
      info(`gate 已失败 ${rounds} 轮，超过修复上限 rework_rounds=${cap}：按协议应 gate fail 后直接 finish failed。`);
    }
  }
  ledger.gate_status = result;
  ledger.gate_rounds = rounds;
  atomicSave(args, ledger);
  console.log(`gate=${result} rounds=${rounds}${result === 'fail' ? '（需要修复员介入，修复后重跑 gate）' : ''}`);
  return 0;
}

/**
 * bounce <cardId> --stdin — 扩编分诊的第三类：属于某张在跑卡自身的卡内尾巴。
 * 把追加指令记到目标卡的 bounces 上（主会话的返工 prompt 从这里取），并落账来源卡。
 * 上限 MAX_BOUNCE_BATCHES 批/卡；超限或目标卡已到终态（迟到）→ 自动转 deferred（报告「下轮待办」）。
 * 返回 0=已打回，0 也是超限转 deferred；目标卡不合法/pending 时报错退出。
 */
function cmdBounce(args) {
  const targetId = args._[0];
  if (targetId == null) die('用法: swarm-ledger bounce <cardId> --stdin（cardId 为被打回的目标卡）。');
  if (args.stdin !== true) die('bounce 需要 --stdin（stdin 传 {"text":...,"source_card_id":...}）。');
  const input = cloneSafe(readStdinJson(`bounce 到卡 #${targetId}`));
  const ledger = loadStrict(args);
  if (ledger.status !== 'running') die(`台账状态为 ${ledger.status}，bounce 仅在 running 时可用。`);
  const deferred = ensureArrayField(ledger, 'deferred');
  ensureArrayField(ledger, 'findings');
  ensureArrayField(ledger, 'fixer_changes');

  const target = findCard(ledger, targetId);
  const text = entryText(input);
  if (!text.trim()) die('bounce 缺少 text/title/summary/changes 描述。');
  if (input.source_card_id != null) findCard(ledger, input.source_card_id); // 来源卡必须存在

  // 打进 deferred 的统一出口：迟到（终态）与超限都不该让主会话干等，直接留到下一轮。
  const toDeferred = (reason) => {
    const entry = {
      id: nextEntryId(deferred, deferred.length + 1),
      text,
      kind: 'bounce',
      target_card_id: String(target.id),
      reason,
      created_at: nowIso(),
    };
    if (input.source_card_id != null) entry.card_id = String(input.source_card_id);
    deferred.push(entry);
    atomicSave(args, ledger);
    info(`卡 #${target.id} 打回${reason}，已转 deferred #${entry.id}（共 ${deferred.length} 条）。`);
    console.log(JSON.stringify(entry, null, 2));
    return 0;
  };

  if (['passed', 'failed'].includes(target.state)) return toDeferred('迟到（目标卡已到终态）');
  if (target.state === 'pending') {
    die(`卡 #${target.id} 仍为 pending（尚未开工），不能打回：请用 spawn 扩编新卡，或用 finding 记为发现。`);
  }
  const bounces = ensureArrayField(target, 'bounces');
  if (bounces.length >= MAX_BOUNCE_BATCHES) return toDeferred(`超限（每卡最多 ${MAX_BOUNCE_BATCHES} 批）`);

  const entry = {
    id: nextEntryId(bounces, bounces.length + 1),
    text,
    created_at: nowIso(),
  };
  if (input.source_card_id != null) entry.source_card_id = String(input.source_card_id);
  bounces.push(entry);
  atomicSave(args, ledger);
  info(`卡 #${target.id} 已接收第 ${bounces.length} 批打回指令（共 ${bounces.length}/${MAX_BOUNCE_BATCHES} 批）。`);
  console.log(JSON.stringify(entry, null, 2));
  return 0;
}

function cmdFixer(args) {
  if (args.stdin !== true) die('fixer 需要 --stdin（stdin 传 {"card_id":...,"changes":...}）。');
  const input = cloneSafe(readStdinJson('fixer'));
  const ledger = loadStrict(args);
  // 同 finding：缺数组/类型不对的老台账先规整，别让 push 崩掉。
  ensureArrayField(ledger, 'findings');
  ensureArrayField(ledger, 'deferred');
  const fixerChanges = ensureArrayField(ledger, 'fixer_changes');
  if (input.card_id == null && input.changes == null && input.text == null && input.summary == null) {
    die('fixer 记录缺少 card_id/changes/text/summary 任意一项。');
  }
  if (input.card_id != null) findCard(ledger, input.card_id); // 顺带校验卡存在
  const entry = input;
  entry.id = entry.id ?? nextEntryId(fixerChanges, fixerChanges.length + 1);
  entry.created_at = entry.created_at ?? nowIso();
  fixerChanges.push(entry);
  atomicSave(args, ledger);
  info(`已记录修复改动 #${entry.id}（共 ${fixerChanges.length} 条）。`);
  console.log(JSON.stringify(entry, null, 2));
  return 0;
}

function cmdFinish(args) {
  const status = args._[0];
  if (status !== 'completed' && status !== 'failed') die('用法: swarm-ledger finish <completed|failed>。');
  const ledger = loadStrict(args);
  if (ledger.status !== 'running') die(`台账已是 ${ledger.status}，无需重复 finish。`);
  // completed = 全部完成，语义硬闸：有未终态卡时拒绝（2026-11-21 事故：5 张 reviewing
  // 漏收直接 finish completed，报告渲染出 0/5 假失败）。收卡出路：逐卡 update 终态；
  // 确认无法收卡（builder 死亡/放弃）→ 逐卡写 failed，或直接 finish failed 宽松收尾。
  const unfinished = cardList(ledger).filter((c) => !['passed', 'failed'].includes(c.state));
  if (status === 'completed' && unfinished.length > 0) {
    die(`还有 ${unfinished.length} 张卡未到终态，不能标记 completed：${unfinished.map((c) => `#${c.id}[${c.state}]`).join(' ')}。先逐卡收卡（reviewing → passed/failed），或改用 finish failed 收尾（放弃/崩溃场景）。`);
  }
  ledger.status = status;
  // 清理 watchdog 定时器
  try {
    const markerPath = join(tmpdir(), `swarm-watchdog-${ledger.run_id}.json`);
    if (existsSync(markerPath)) unlinkSync(markerPath);
  } catch { /* 清理失败不阻塞收尾 */ }
  atomicSave(args, ledger);

  const counts = Object.create(null); // 无原型：手改台账里 state 写成 "__proto__" 也不会串到原型上
  for (const c of cardList(ledger)) counts[c.state] = (counts[c.state] ?? 0) + 1;
  const states = CARD_STATES.map((s) => (counts[s] ? `${s}=${counts[s]}` : null)).filter(Boolean).join(' ');
  console.log(`运行 ${ledger.run_id} 已标记 ${status}。卡状态：${states || '无'}`);
  if (unfinished.length) {
    info(`注意：仍有 ${unfinished.length} 张卡未到终态（${unfinished.map((c) => `#${c.id}[${c.state}]`).join(' ')}），请核对报告中的「需要你处理」。`);
  }
  return 0;
}

/** 台账里的卡列表：过滤掉非对象条目（手改台账/坏数据不应让任何只读命令崩掉）。 */
function cardList(ledger) {
  return asArray(ledger && ledger.cards).filter(isPlainObject);
}

/** 看板卡片一行备注。 */
function shortNote(card) {
  const err = entryText(card.error);
  if (err) return clip(err, 60);
  const r = resultText(card.result);
  switch (card.state) {
    case 'passed':
      return clip(r || '已通过', 60);
    case 'failed':
      return clip(r || '已失败', 60);
    case 'rework':
      return `第${countOf(card.round)}轮返工`;
    case 'reviewing':
      return countOf(card.round) > 0 ? `审查中（已返工${countOf(card.round)}次）` : '审查中';
    case 'working':
      return '施工中';
    default:
      return '待启动';
  }
}

/** 看板标题：需求原文优先，其次 run_id（非字符串/脏值不回显），最后固定名。 */
function boardTitle(ledger) {
  const req = requirementText(ledger);
  if (req) return req;
  const runId = ledger && typeof ledger.run_id === 'string' ? ledger.run_id.trim() : '';
  return runId || 'swarm-ledger';
}

function cmdBoard(args) {
  const l = loadStrict(args);
  const out = {
    title: boardTitle(l),
    run_id: l.run_id ?? null,
    status: l.status ?? null,
    cards: cardList(l).map((c) => ({
      id: c.id,
      title: c.title,
      state: c.state,
      role: c.role,
      note: shortNote(c),
    })),
    gate: {
      command: typeof l.gate === 'string' ? l.gate : null,
      status: l.gate_status ?? null,
      rounds: countOf(l.gate_rounds),
    },
    findings_count: asArray(l.findings).length,
    deferred_count: asArray(l.deferred).length,
    elapsed: fmtElapsed(l.created_at ?? '', l.status === 'running' ? nowIso() : l.updated_at ?? nowIso()),
  };
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

/** gate 结果的人类可读文本：只认 pass/fail，手改台账里的其他值原样显示。 */
function gateResultText(ledger) {
  const rounds = countOf(ledger.gate_rounds);
  if (ledger.gate_status == null) return '未运行';
  if (ledger.gate_status === 'pass') return `通过（第 ${rounds} 轮）`;
  if (ledger.gate_status === 'fail') return `未通过（第 ${rounds} 轮）`;
  return String(ledger.gate_status);
}

/** 条目 id 展示：缺 id 时用序号，不输出 undefined。 */
function entryId(entry, index) {
  if (isPlainObject(entry) && entry.id != null && String(entry.id).trim()) return String(entry.id);
  return String(index + 1);
}

function cmdReport(args) {
  const l = loadStrict(args);
  const cards = cardList(l);
  const findings = asArray(l.findings);
  const deferred = asArray(l.deferred);
  const fixerChanges = asArray(l.fixer_changes);
  const out = [];
  const elapsed = fmtElapsed(l.created_at ?? '', l.status === 'running' ? nowIso() : l.updated_at ?? nowIso());
  const gateText = gateResultText(l);

  out.push(`# 蜂群施工报告 · ${displayRunId(l)}`, '');
  out.push(`- **需求**：${requirementText(l) || '-'}`);
  out.push(`- **运行状态**：${l.status ?? '?'}`);
  out.push(`- **时间**：${l.created_at ?? '-'} 开始 / ${l.updated_at ?? '-'} 最后更新（耗时 ${elapsed}）`);
  out.push(`- **验证命令**：${gateLabel(l.gate)}`);
  out.push(`- **验证结果**：${gateText}`, '');

  // 运行元数据（来自 init）：审查档位与返工上限，报告顶层给出来源一目了然。
  const reportCap = reworkCapOf(l);
  if (reportCap != null) out.push(`- **返工上限**：${reportCap} 轮`, '');

  // 角色模型表：agent_models.resolved 是本次运行每个角色实际用的模型与来源（宿主设置 / 继承默认）。
  const agentResolved = isPlainObject(l.agent_models) && asArray(l.agent_models.resolved).length
    ? asArray(l.agent_models.resolved).filter(isPlainObject)
    : null;
  if (agentResolved) {
    out.push('## 团队角色模型', '');
    out.push('模型由 ZCode 设置 → 子智能体 → ZCode Swarm 决定，插件不再配置模型。', '');
    out.push('| 角色 | 实际模型 | 来源 |');
    out.push('|------|----------|------|');
    for (const item of agentResolved) {
      const role = mdEscape(String(item.role ?? ''));
      const model = item.model === 'inherit' ? '跟随会话模型' : mdEscape(String(item.model ?? ''));
      out.push(`| ${role} | ${model} | ${mdEscape(String(item.source ?? ''))} |`);
    }
    out.push('');
  }

  out.push('## 任务分工表', '');
  out.push('| # | 任务 | 角色 | 状态 | 轮次 | 结果摘要 |');
  out.push('|---|------|------|------|:---:|----------|');
  for (const c of cards) {
    const summary = entryText(c.error) ? `ERROR: ${entryText(c.error)}` : resultText(c.result) || '-';
    out.push(
      `| ${mdEscape(c.id)} | ${mdEscape(c.title)} | ${mdEscape(c.role)} | ${mdEscape(c.state)} | ${countOf(c.round)} | ${mdEscape(clip(summary, 80))} |`
    );
  }
  out.push('');

  out.push('## 验证（Gate）', '');
  out.push(`- 命令：${gateLabel(l.gate)}`);
  out.push(`- 结果：${gateText}`);
  if (fixerChanges.length) {
    out.push('', '**修复记录**：');
    fixerChanges.forEach((f, i) => {
      const when = isPlainObject(f) && f.created_at ? `${f.created_at} ` : '';
      const cardRef = isPlainObject(f) && f.card_id != null ? `卡#${f.card_id} ` : '';
      out.push(`- ${when}${cardRef}${mdEscape(clip(entryText(f), 160))}`);
    });
  }
  out.push('');

  out.push('## 卡片详情', '');
  for (const c of cards) {
    out.push(`### #${c.id} ${mdEscape(c.title ?? '')} （${c.state}，第 ${countOf(c.round)} 轮）`);
    if (c.task) out.push(`- 任务：${mdEscape(clip(c.task, 300))}`);
    if (c.scope) out.push(`- 范围：${mdEscape(clip(c.scope, 200))}`);
    if (c.acceptance) out.push(`- 验收：${mdEscape(clip(c.acceptance, 200))}`);
    if (c.result != null) out.push(`- 结果：${mdEscape(clip(resultText(c.result) || safeJson(c.result), 300))}`);
    if (c.review != null) {
      out.push(`- 审查：${mdEscape(clip(typeof c.review === 'string' ? c.review : safeJson(c.review), 300))}`);
    }
    if (c.error) out.push(`- 错误：${mdEscape(entryText(c.error))}`);
    if (asArray(c.spawns).length) out.push(`- 扩编：${asArray(c.spawns).map((s) => `#${s}`).join('、')}`);
    if (asArray(c.bounces).length) {
      const lines = asArray(c.bounces).map((b, i) => `第${i + 1}批 ${mdEscape(clip(entryText(b), 120))}`);
      out.push(`- 打回（${asArray(c.bounces).length}/${MAX_BOUNCE_BATCHES} 批）：${lines.join('；')}`);
    }
    out.push('');
  }

  out.push('## 发现（Findings）', '');
  if (!findings.length) out.push('（无）');
  else {
    findings.forEach((f, i) => {
      const cardRef = isPlainObject(f) && f.card_id != null ? `（卡#${f.card_id}）` : '';
      const kind = isPlainObject(f) && typeof f.kind === 'string' && f.kind.trim() ? `${mdEscape(f.kind)}：` : '';
      out.push(`- [#${entryId(f, i)}] ${kind}${mdEscape(clip(entryText(f), 200))}${cardRef}`);
    });
  }
  out.push('');

  out.push('## 遗留（Deferred）', '');
  if (!deferred.length) out.push('（无）');
  else {
    deferred.forEach((d, i) => {
      const notes = [];
      if (isPlainObject(d) && d.target_card_id != null) notes.push(`目标卡#${d.target_card_id}`);
      if (isPlainObject(d) && typeof d.reason === 'string' && d.reason.trim()) notes.push(d.reason);
      const suffix = notes.length ? `（${mdEscape(notes.join('；'))}）` : '';
      out.push(`- [#${entryId(d, i)}] ${mdEscape(clip(entryText(d), 200))}${suffix} —— 需人工决策`);
    });
  }
  out.push('');

  out.push('## 需要你处理', '');
  const todo = [];
  if (l.gate_status === 'fail') todo.push(`- 验证未通过（第 ${countOf(l.gate_rounds)} 轮）：需要修复员介入或调整 gate 后重跑。`);
  // 修复轮上限：gate 失败轮数超过 rework_rounds 时，协议要求收尾为 failed。
  const gateCap = reworkCapOf(l);
  if (l.gate_status === 'fail' && gateCap != null && countOf(l.gate_rounds) > gateCap) {
    todo.push(`- 修复轮数已超过上限（rework_rounds=${gateCap}）：按协议直接 finish failed 收尾，别再修。`);
  }
  for (const c of cards) {
    const title = mdEscape(c.title ?? '');
    if (c.state === 'failed') todo.push(`- 卡 #${c.id}「${title}」失败${entryText(c.error) ? `：${mdEscape(clip(entryText(c.error), 100))}` : ''}，需人工介入或重派。`);
    else if (c.state === 'rework') todo.push(`- 卡 #${c.id}「${title}」等待返工（第 ${countOf(c.round)} 轮）。`);
    else if (l.status === 'completed' && ['pending', 'working', 'reviewing'].includes(c.state)) {
      todo.push(`- 卡 #${c.id}「${title}」仍为 ${c.state}，但运行已标记 completed，请核对。`);
    }
  }
  if (l.status === 'running') {
    for (const c of cards) {
      if (c.state === 'pending') todo.push(`- 卡 #${c.id}「${mdEscape(c.title ?? '')}」待启动（next）。`);
    }
    // 空 gate 是合法场景（无验证命令）；只有配了 gate 才提醒去跑。
    if (typeof l.gate === 'string' && l.gate.trim() && l.gate_status == null && cards.every((c) => ['passed', 'failed'].includes(c.state))) {
      todo.push('- 全部卡已到终态但 gate 尚未运行：执行 gate 后再 finish。');
    }
  }
  if (!todo.length) out.push('（无待处理事项）');
  else out.push(...todo);
  out.push('');

  const text = out.join('\n');
  console.log(text);
  // 归档内容与 stdout 完全一致（console.log 会补一个换行），归档失败不阻断报告输出。
  writeArtifactFile(join(artifactDirOf(args, l), 'report.md'), `${text}\n`, false);
  return 0;
}

/** JSON 化兜底：永不抛（手改台账里的对象可能含不可序列化值）。 */
function safeJson(value) {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : '';
  } catch {
    return '';
  }
}

function requirementText(ledger) {
  for (const key of REQUIREMENT_KEYS) {
    const value = ledger[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/**
 * watchdog [--stale-min N] [--kill-min N] —— 子代理状态巡检（收卡主动轮询的"事实半边"）。
 * 背景（2026-11-20/21 两起通知丢失事故）：完成/失败通知都可能丢，主会话被动等待会把
 * 已死/已完成的卡晾整夜。本命令把"谁超时了"变成脚本事实：
 *   - working/reviewing 且 updated_at 距今超过 --stale-min（默认 30）分钟 → 列出，建议按 agent_id 用 TaskOutput 主动查；
 *   - 超过 --kill-min（默认 90）分钟 → 追加「可判死」标记（主会话写 failed 并披露/接管）；
 *   - 卡上没 agent_id → 提示下批派工要落 agent_id；
 *   - 无超时卡输出「无超时卡」，exit 0。运行不在 running 状态时静默退出（钩子可空跑）。
 * 输出走 stdout（机器可读行），每行一条卡事实；退出码恒 0——巡检本身不构成失败。
 */
/**
 * route <用户消息> —— 中途消息路由建议（第 2 层：事实半边）。
 * 用户在蜂群运行中发消息时，主会话第一步跑这个命令：拿到当前运行状态、
 * 每张卡的范围/状态/agent_id，以及基于关键词匹配的路由建议。
 * 输出走 stdout，退出码恒 0（路由是建议不是校验）。
 * 2026-11-21 事故背景：主会话收到中途消息时未检查活跃蜂群，直接自己处理了——
 * SKILL 第 1 层规则 + 本命令（第 2 层事实）双层保障。
 */
// 中文片段匹配（第三层）的通用词黑名单：这些词太常见（如「模块」「系统」），出现在用户消息里
// 不代表消息指向该卡——「再加一个UI模块」不应命中标题含「模块」的卡。只有黑名单外的
// 领域特定词（如「音效」）才能作为第三层匹配依据。
const ROUTE_GENERIC_CJK_WORDS = new Set([
  '模块', '系统', '优化', '修复', '实现', '处理', '配置', '更新', '调整', '文档',
  '测试', '回归', '接入', '完善', '支持', '添加', '新增', '改进', '修正', '统一', '同步',
]);

function cmdRoute(args) {
  const msg = args._.join(' ').trim();
  const ledger = readLedger(args, true);
  if (!ledger || ledger.status !== 'running') {
    info('当前没有运行中的蜂群，正常处理即可（不需要 swarm 路由）。');
    return 0;
  }
  const cards = cardList(ledger);
  const lines = [`[RUN] ${displayRunId(ledger)} running，${cards.length} 张卡：`];
  const keywords = msg.toLowerCase();
  const matches = [];
  for (const c of cards) {
    const scope = String(c.scope ?? '').toLowerCase();
    const title = String(c.title ?? '').toLowerCase();
    // 关键词匹配（三层）：scope 路径末段 → 标题切词 → 标题中文片段（取连续 ≥2 个 CJK 字符的片段）
    let hit = '';
    const scopeSeg = scope.split('/').filter(Boolean).pop() ?? '';
    if (scopeSeg && keywords.includes(scopeSeg.toLowerCase())) hit = `scope 命中「${c.scope}」`;
    if (!hit) {
      const titleWords = title.split(/[\s（(·:：,，\-—]+/).filter((w) => w.length >= 2);
      for (const w of titleWords) {
        if (keywords.includes(w)) { hit = `标题关键词命中「${w}」`; break; }
      }
    }
    if (!hit) {
      // 中文片段匹配：从标题里提取连续 ≥2 个 CJK 字符的片段，任一出现在消息里即命中
      const cjkRuns = title.match(/[一-鿿]{2,}/g) ?? [];
      for (const run of cjkRuns) {
        // 取片段的前半部分（如「音效模块」→ 尝试「音效」和「模块」）
        for (let len = Math.min(run.length, 4); len >= 2; len--) {
          for (let i = 0; i + len <= run.length; i++) {
            const frag = run.slice(i, i + len);
            // 通用词（如「模块」）不作数：太常见，命中不代表消息指向该卡
            if (ROUTE_GENERIC_CJK_WORDS.has(frag)) continue;
            if (keywords.includes(frag)) { hit = `标题片段命中「${frag}」`; break; }
          }
          if (hit) break;
        }
        if (hit) break;
      }
    }
    const aid = c.agent_id ? `agent_id=${c.agent_id}` : '未派工';
    lines.push(`  #${c.id}[${c.state}] ${hit ? `★${hit} ` : ''}scope=${c.scope || '未限定'} ${aid} | ${c.title}`);
    if (hit) matches.push({ id: c.id, state: c.state, reason: hit });
  }
  // 路由建议
  if (msg.length === 0) {
    lines.push('建议：未提供消息内容，仅列出当前状态。');
  } else if (/取消|算了|不要|别做|撤销/.test(msg)) {
    lines.push('建议：取消类消息 → 对应卡 update failed（附 error=用户取消），或 finish failed 收尾。');
  } else if (/暂停|停下|先别/.test(msg)) {
    lines.push('建议：暂停类 → 等在飞卡收完再 finish；紧急时 finish failed。');
  } else if (matches.some((m) => m.state === 'working' || m.state === 'reviewing' || m.state === 'rework')) {
    lines.push(`建议：消息匹配在飞卡 ${matches.filter((m) => ['working','reviewing','rework'].includes(m.state)).map((m) => `#${m.id}`).join(' ')} → bounce 追加指令到该卡。`);
  } else if (matches.length > 0) {
    lines.push(`建议：消息匹配已终态卡 ${matches.map((m) => `#${m.id}[${m.state}]`).join(' ')} → passed 卡不可改，spawn 新卡。`);
  } else {
    lines.push('建议：消息未匹配任何在飞卡 → 若是新工作，spawn 扩编新卡后派工；若与当前 run 无关，正常回答并告知蜂群仍在跑。');
  }
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

function cmdWatchdog(args) {
  const staleMin = Math.max(1, Number(args['stale-min']) || 30);
  const killMin = Math.max(staleMin, Number(args['kill-min']) || 90);
  const ledger = readLedger(args, true);
  if (!ledger || ledger.status !== 'running') return 0;
  // 自注册定时器：首次派工后自动创建 30 分钟巡检，finish 时自动删除
  // 主会话不需要手动 CronCreate/CronDelete——脚本侧管理生命周期
  const markerPath = join(tmpdir(), `swarm-watchdog-${ledger.run_id}.json`);
  if (!existsSync(markerPath)) {
    try {
      writeFileSync(markerPath, JSON.stringify({ run_id: ledger.run_id, created_at: new Date().toISOString(), staleMin, killMin }));
      info(`watchdog 定时器已自注册（run_id=${ledger.run_id}，阈值 ${staleMin}/${killMin} 分钟）。运行结束时会自动清理。`);
    } catch (err) {
      info(`watchdog 自注册失败：${err.message}`);
    }
  }
  const now = Date.now();
  const lines = [];
  for (const card of cardList(ledger)) {
    if (card.state !== 'working' && card.state !== 'reviewing' && card.state !== 'pending') continue;
    const stamp = Date.parse(card.updated_at ?? ledger.updated_at ?? '') || 0;
    if (!stamp) continue;
    const ageMin = Math.floor((now - stamp) / 60000);
    // pending 未派工是独立盲区（2026-11-21 sess_66d055e8 事故：init 后 spawn 被静默拒绝，
    // 台账冻结在 pending——watchdog 原先只扫 working/reviewing，永远报不出来）。
    if (card.state === 'pending') {
      if (ageMin >= staleMin) {
        lines.push(`[NOT-DISPATCHED] 卡 #${card.id} pending 已 ${ageMin} 分钟未派工（无 agent_id）— 检查 spawn 是否被拒（模型配额/解析失败），或补派工`);
      }
      continue;
    }
    if (ageMin < staleMin) continue;
    const tag = ageMin >= killMin ? 'KILL' : 'STALE';
    const act = ageMin >= killMin
      ? `已 ${ageMin} 分钟无进展：判死（update <id> --stdin 写 {"state":"failed","error":"停摆判死 <原因>"}），接管或等待用户`
      : `已 ${ageMin} 分钟无通知：用 TaskOutput 按 agent_id 主动查一次，completed 就地收卡`;
    const aid = card.agent_id ? `agent_id=${card.agent_id}` : 'agent_id 缺失（下批派工记得 update 落 agent_id）';
    lines.push(`[${tag}] 卡 #${card.id} ${card.state} ${aid} — ${act}`);
  }
  if (lines.length === 0) info(`watchdog：无超时卡（阈值 ${staleMin}/${killMin} 分钟）`, args.quiet === true);
  else process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

/** 展示用 run_id：台账可能被手改（含换行/控制字符会污染报告与钩子注入文本），先过白名单。 */
function displayRunId(ledger) {
  const raw = ledger && ledger.run_id;
  if (typeof raw !== 'string' || !raw) return '未知';
  return sanitizeRunId(raw);
}

/** 恢复检查：status=running 时提示，其余（不存在/已完成）静默。 */
function cmdRecover(args) {
  const quiet = args.quiet === true;
  const ledger = readLedger(args, quiet);
  if (!ledger) return 0;
  if (ledger.status !== 'running') return 0;
  const runId = displayRunId(ledger);
  // 未到终态的卡就是还没跑完的：pending/working/reviewing/rework 都计入「进行中」。
  const running = cardList(ledger).filter((c) => !['passed', 'failed'].includes(c.state)).length;
  // 提示必须走 stdout：SessionStart 钩子只把 stdout 注入宿主上下文，stderr 会被钩子丢弃。
  // --quiet 时保持静默（钩子命令本身带 --quiet）。
  if (!quiet) {
    console.log(
      `[swarm-ledger] 发现未完成的团队运行 ${runId}（${running} 张卡进行中）：在 ZCode 里发 /swarm resume 续跑，或 /swarm abandon 放弃并归档`
    );
  }
  return 0;
}

/* ------------------------------ 可视化渲染 ------------------------------ */

/**
 * render <board|report> — 取台账数据 → 注入 HTML 模板 → 写入 Gen UI 可视化目录 → 输出 ::visualize 行。
 * 主会话只调这一条命令，不即兴注入（S2 纪律：脚本强制优先于文档）。
 */
function cmdRender(args) {
  const kind = args._[0]; // board 或 report（命令名已被分发层剥掉）
  if (kind !== 'board' && kind !== 'report') {
    die('用法: swarm-ledger render <board|report>');
  }
  // 脚本自身目录 → 插件 templates/（fileURLToPath 会正确解码中文/空格路径里的 %XX）
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const basePath = ledgerPath(args);
  const ledger = readLedger(args, false);
  if (!ledger || !Array.isArray(ledger.cards)) {
    die('台账不存在或损坏，无法渲染');
  }
  // 渲染是只读命令，但坏台账（cards 里混入非对象）不该让 render 崩：cardList 会过滤，这里只保证 cards 是数组。

  // 1. 取数据（项目根由 ledgerPath 反推，避免再解析一次 --project/SWARM_PROJECT 出现口径差异）
  const projectRoot = dirname(dirname(basePath)); // .swarm/ledger.json → 项目根
  const data = kind === 'board' ? buildBoardData(ledger, projectRoot) : buildReportCardData(ledger);

  // 2. 读模板（相对于脚本位置 → 插件 templates/）
  const templatePath = join(scriptDir, '..', 'templates', kind === 'board' ? 'board-card.html' : 'report-card.html');
  if (!existsSync(templatePath)) {
    die(`找不到模板: ${templatePath}`);
  }
  let tpl = readFileSync(templatePath, 'utf8');

  // 3. 注入 DATA 占位符。必须用函数替换：字符串替换参数会解释 $& / $` / $' 等序列，
  //    JSON 里的这些字符（如标题含 "cost $& price"）会被替换成匹配串本身，数据就坏了。
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  tpl = tpl.replace(/\/\*@@DATA@@\*\/[\s\S]*?\/\*@@END@@\*\//, () => json);
  tpl = tpl.replace(/\/\*@@DATA@@\*\//g, '').replace(/\/\*@@END@@\*\//g, '');

  // 4. 写入 Gen UI 目录
  const rootEnv = process.env.ZCODE_GEN_UI_OUTPUT_ROOT;
  if (!rootEnv) {
    die('缺少 ZCODE_GEN_UI_OUTPUT_ROOT 环境变量，无法生成可视化卡片');
  }
  const session = (process.env.ZCODE_SESSION_ID || 'session').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'session';
  // run_id 来自台账，可能被篡改成 ../../evil；统一走 sanitizeRunId，杜绝路径穿越。
  const runId = sanitizeRunId(ledger.run_id);
  const fileName = `swarm-${kind}-${runId}.html`;
  const outPath = join(resolve(rootEnv), 'zcode-swarm', session, fileName);
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, tpl, 'utf8');
  } catch (err) {
    die(`可视化卡片写入失败（${outPath}）：${err.message}`);
  }

  // 5. 输出 ::visualize 行到 stderr（主会话原样放进回复正文）
  const vizPath = outPath.replace(/\\/g, '/');
  console.error(`[swarm-ledger] 已生成: ${vizPath}`);
  console.error(`::visualize{"path":"${vizPath}"}`);
  return 0;
}

/** 从台账构建看板数据（与 board 命令同构，加上模板需要的额外字段）。 */
function buildBoardData(ledger, projectRoot) {
  const base = {
    title: boardTitle(ledger),
    run_id: ledger.run_id ?? null,
    status: ledger.status ?? null,
    cards: cardList(ledger).map((c) => {
      const review = isPlainObject(c.review) ? c.review : null;
      const res = isPlainObject(c.result) ? c.result : null;
      const clipStr = (v, n) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n - 1) + '…' : v) : '');
      return {
        id: c.id,
        title: c.title,
        state: c.state,
        role: c.role,
        round: countOf(c.round),
        // 备注与 cmdBoard 的 shortNote 同源：result 是字符串时也能取到摘要。
        note: shortNote(c),
        // 卡片详情（会话内看板点击展开用，字段口径与 swarm-board-server 的 boardData 一致）：
        scope: clipStr(c.scope, 400),
        task: clipStr(c.task, 2000),
        acceptance: clipStr(c.acceptance, 1000),
        summary: clipStr(resultText(c.result) || (typeof c.error === 'string' ? c.error : ''), 1200),
        error: clipStr(typeof c.error === 'string' ? c.error : '', 600),
        checks: asArray(res?.checks).slice(0, 40).map((x) => clipStr(String(x), 400)).filter(Boolean),
        changed: asArray(res?.changed).slice(0, 40).map((x) => String(x)),
        open_items: asArray(res?.open).slice(0, 20).map((x) => clipStr(String(x), 400)).filter(Boolean),
        review_pass: review && typeof review.pass === 'boolean' ? review.pass : null,
        review_findings: asArray(review?.findings).slice(0, 15).map((x) => clipStr(String(x), 400)).filter(Boolean),
        bounces: asArray(c.bounces).length,
        spawns: asArray(c.spawns).length,
        launched_at: c.launched_at ?? null,
        completed_at: c.completed_at ?? null,
      };
    }),
    gate: {
      command: typeof ledger.gate === 'string' ? ledger.gate : null,
      status: ledger.gate_status ?? null,
      rounds: countOf(ledger.gate_rounds),
    },
    // 运行阶段与结算进度：口径与 swarm-board-server 的 boardData() 一致（会话内看板与侧栏面板同源）。
    counts: (() => {
      const c = { passed: 0, failed: 0, working: 0, reviewing: 0, rework: 0, pending: 0 };
      for (const card of cardList(ledger)) {
        if (Object.prototype.hasOwnProperty.call(c, card.state)) c[card.state] += 1;
      }
      return c;
    })(),
    findings_count: asArray(ledger.findings).length,
    deferred_count: asArray(ledger.deferred).length,
    // 与 cmdBoard 同式：running 时算到当前时刻，结束的取 updated_at。
    elapsed: fmtElapsed(ledger.created_at, ledger.status === 'running' ? nowIso() : ledger.updated_at),
  };
  const total = base.cards.length;
  const settled = base.counts.passed + base.counts.failed;
  base.phase = (() => {
    if (ledger.status !== 'running') return ledger.status === 'completed' ? 'done' : 'stopped';
    const c = base.counts;
    if (c.pending > 0 && c.working === 0 && c.reviewing === 0 && c.rework === 0) return 'dispatching';
    if (c.working > 0 || c.rework > 0) return 'building';
    if (c.reviewing > 0) return 'reviewing';
    if (c.pending === 0 && c.working === 0 && c.reviewing === 0 && c.rework === 0) return 'gate';
    return 'building';
  })();
  base.progress = { total, settled, percent: total > 0 ? Math.round((settled / total) * 100) : 0 };
  base.artifact_dir = typeof ledger.artifact_dir === 'string' ? ledger.artifact_dir : '';
  base.design_md = '';
  // design.md 放在产物目录：路径必须仍在项目根内（artifact_dir 是被手改过的值）。
  if (base.artifact_dir && projectRoot) {
    const designPath = resolve(projectRoot, base.artifact_dir, 'design.md');
    if (isInsidePath(designPath, projectRoot) && existsSync(designPath)) {
      try {
        const content = readFileSync(designPath, 'utf8').trim();
        base.design_md = content.length > 0 ? content.slice(0, 200) : '';
      } catch {
        base.design_md = '';
      }
    }
  }
  return base;
}

/** 从台账构建报告卡片数据。 */
function buildReportCardData(ledger) {
  // 角色 → 实际模型：agent_models.resolved 里按角色查（角色名可能带 swarm- 前缀）。
  const roleModels = isPlainObject(ledger.agent_models) && asArray(ledger.agent_models.resolved).length
    ? asArray(ledger.agent_models.resolved).filter(isPlainObject)
    : [];
  const modelForRole = (role) => {
    const norm = String(role || '').trim().toLowerCase().replace(/^swarm-/, '');
    if (!norm) return '';
    const hit = roleModels.find(
      (item) => String(item.role ?? '').trim().toLowerCase().replace(/^swarm-/, '') === norm,
    );
    if (!hit) return '';
    return hit.model === 'inherit' ? '跟随会话' : String(hit.model ?? '');
  };
  const cards = cardList(ledger).map((c) => ({
    id: c.id,
    title: c.title,
    role: c.role,
    // 卡上原本记的是档位键（已废弃）；报告展示该角色本次实际跑的模型，查不到就留空。
    model: modelForRole(c.role),
    result: c.state,
    rounds: countOf(c.round),
    // result 可能是字符串（施工员摘要）或对象；统一走 resultText，别只认 .summary。
    summary: resultText(c.result) || entryText(c.error) || c.state,
  }));
  const passed = cardList(ledger).filter((c) => c.state === 'passed').length;
  // 台账里没写 gate_status 时不能落成 'not_run' 字符串：模板据此判「未运行」是另一套文案；
  // 用 null 让模板自己走「未运行」，同时保留 gate 命令供展示。
  const gateStatus = ledger.gate_status == null ? null : ledger.gate_status;
  return {
    title: `团队施工报告：${passed}/${cards.length} 张任务卡通过`,
    requirement: requirementText(ledger).slice(0, 200),
    cards,
    gate: {
      command: typeof ledger.gate === 'string' ? ledger.gate : '',
      // 模板认 pass/fail/'not_run'；配了 gate 但尚未跑时给 'not_run'，没配 gate 时给 null（模板显示无验证命令）。
      status: gateStatus ?? (typeof ledger.gate === 'string' && ledger.gate.trim() ? 'not_run' : null),
      rounds: countOf(ledger.gate_rounds),
    },
    agent_models: isPlainObject(ledger.agent_models) ? ledger.agent_models : null,
    // cmdFinding 实际写入的字段是 text/title/summary/card_id，模板读 what/where。
    findings: asArray(ledger.findings).map((f) => ({
      what: entryText(f),
      where: isPlainObject(f) && f.card_id != null ? `卡#${f.card_id}` : '',
    })),
    deferred: asArray(ledger.deferred).map((d) => {
      // cmdFinding 写入 text/title/summary；模板拼 title + reason（中间加「：」）。
      // 只有 summary 时不要再拿它当 reason，否则渲染成 "X：X"。
      const heading = isPlainObject(d) ? d.title ?? d.text : null;
      if (heading != null) return { title: heading, reason: isPlainObject(d) && d.summary != null ? d.summary : '' };
      return { title: entryText(d), reason: '' };
    }),
  };
}

/* ------------------------------ 分发 ------------------------------ */

/** 命令分发表：主命令 → 处理函数（返回退出码）。新增命令在这里加一行。 */
const COMMANDS = {
  init: cmdInit,
  status: cmdStatus,
  update: cmdUpdate,
  artifact: cmdArtifact,
  next: cmdNext,
  spawn: cmdSpawn,
  bounce: cmdBounce,
  finding: cmdFinding,
  gate: cmdGate,
  fixer: cmdFixer,
  finish: cmdFinish,
  board: cmdBoard,
  report: cmdReport,
  render: cmdRender,
  recover: cmdRecover,
  watchdog: cmdWatchdog,
  route: cmdRoute,
};

function usage() {
  console.error(`用法: swarm-ledger.mjs <命令> [参数] [--project <path>]

命令:
  init --stdin               初始化台账（stdin: {requirement, cards[], gate}，
                             gate 可为空串；可选 agent_models/rework_rounds）
  status                     台账摘要（每卡一行: #编号[状态]标题）
  update <cardId> --stdin    更新卡（stdin 深合并，状态转移校验；result/review 自动归档）
  artifact <name> [--stdin]  产物读写：--stdin 写入，不带则读出
                             name: design.md | report.md | card-<id>-result.json
                                   | card-<id>-review.json | 自定义 .md/.json/.txt
  next                       取下一张 pending 卡并置为 working（输出卡 JSON）
  spawn <cardId> --stdin     扩编一张新卡追加到 cards
  bounce <cardId> --stdin    分诊打回：追加指令记到目标卡 bounces（每卡 2 批，超限/迟到转 deferred）
  finding --stdin            追加 finding（"deferred": true 时记入遗留）
  gate <pass|fail> [rounds]  记录验证结果
  fixer --stdin              记录修复员改动
  finish <completed|failed>  标记运行结束
  board                      输出 Gen UI 看板 JSON
  report                     输出 markdown 施工报告（同时归档 report.md）
  render <board|report>      生成 Gen UI 可视化卡片（需 ZCODE_GEN_UI_OUTPUT_ROOT 环境变量，
                             ::visualize 行输出到 stderr）
  recover [--quiet]          钩子用：检查未完成运行并提示（提示走 stdout，永不报错）
  route <用户消息>            蜂群运行中收到用户中途消息时：输出当前卡状态+范围+路由建议
  watchdog [--stale-min N] [--kill-min N]  巡检超时卡（30 分钟 STALE 建议 TaskOutput 查询 /
                             90 分钟 KILL 建议判死；供定时唤醒后一条命令拿到全部事实）

选项: --quiet --project <path>（默认取进程当前目录）`);
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === 'help' || command === '-h' || command === '--help') {
  usage();
  process.exit(command ? 0 : 2);
}
if (!(command in COMMANDS)) {
  console.error(`[swarm-ledger] ERROR: 未知命令 "${command}"。`);
  usage();
  process.exit(2);
}
try {
  // 用 exitCode 而非 process.exit：让 stdout（管道异步写）自然冲刷，避免大输出被截断。
  process.exitCode = COMMANDS[command](parseArgs(rest)) ?? 0;
} catch (err) {
  die(err && err.message ? err.message : String(err));
}
