#!/usr/bin/env node
/**
 * swarm-board — zcode-swarm 常驻侧栏面板的 MCP 服务（stdio，零依赖）。
 *
 * 面板 ui/panel.html 由宿主经标准 MCP resources/read 以 ui://zcode-swarm/panel.html 加载；
 * 实时数据走 ui://zcode-swarm/board.json。面板内运行的 MCP 客户端订阅后者，
 * 台账一变化就收到 notifications/resources/updated 并重读；没有客户端订阅时推送什么也不做。
 *
 * 数据源：<项目根>/.swarm/ledger.json（项目根 = env ZCODE_WORKSPACE_ROOT || 进程当前目录）。
 * 这里刻意不 import swarm-ledger.mjs：面板服务只读台账并自己映射展示层字段，
 * 与台账写脚本保持解耦（台账字段演进不会连带弄坏面板进程）。
 *
 * 协议：JSON-RPC 2.0，stdin/stdout 每行一条消息（ndjson）。官方 stdio server 就是换行分帧，
 * 故未实现 LSP 式 Content-Length 头；行尾 \r 会被剥掉（兼容 Windows 管道），行首 BOM 由 trim 一并去掉。
 * 所有方法处理都是同步的；任何单请求失败只回 JSON-RPC error（-32603 / -32601 / -32602 / -32600），
 * 非对象消息（null/标量）回 -32600 而不是崩掉，JSON-RPC batch 逐条展开（空批/超长批回 -32600）；
 * 未捕获异常只写 stderr，进程不退出。
 *
 * 入口：导出 main() 供宿主 plugin-host 形态（`<ZCode> __zcode-plugin-host <this file>`）导入后调用；
 * 同时保留裸 node 直接运行的自启动（argv[1] 指向本文件时自动 main）。两种形态行为一致。
 *
 * 面板 HTML 来自磁盘（脚本旁的 ../ui/panel.html），而不是内联字符串：
 * 这样面板可以单独编辑/单独无头测试，部署时也不会出现“脚本与页面对不上”。
 * 文件缺失时返回内置降级页（仍可用、带中文说明），绝不把读文件失败抛给宿主。
 */

import { readFileSync, statSync, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER_NAME = 'swarm-board';
const SERVER_VERSION = '0.4.5';
const PANEL_URI = 'ui://zcode-swarm/panel.html';
const BOARD_CARD_URI = 'ui://zcode-swarm/board.html';
const BOARD_URI = 'ui://zcode-swarm/board.json';
/**
 * 可协商的 MCP 协议版本（与宿主内列入表一致，新→旧）。
 * 客户端请求的版本在列表里就回显（表示双方同版）；不认识的版本回最新支持版，由客户端按规范决定是否继续。
 */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const DEFAULT_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];
/**
 * 面板媒体类型：text/html 带 MCP-Apps 的 profile 参数。宿主在 MCP 客户端能力里把可接受的
 * UI 资源类型声明为 `text/html;profile=mcp-app`（官方五插件同款），带参数才最贴合契约；
 * 它是 text/html 的媒体类型变体，按前缀匹配的地方（含我们的测试）同样成立。
 */
const HTML_MIME = 'text/html;profile=mcp-app';
const JSON_MIME = 'application/json';
const LEDGER_REL = join('.swarm', 'ledger.json');
const PANEL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'panel.html');

/** 卡状态 → 中文（与 buildBoardData / board-card.html 口径一致）。 */
const CARD_LABELS = {
  passed: '已通过',
  failed: '未通过',
  working: '施工中',
  reviewing: '审查中',
  rework: '返工中',
  pending: '待开工',
};
/** 只认自有键：台账里的 "__proto__"/"constructor"/"toString" 不能命中原型链。 */
function ownLookup(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
/** 运行状态 → 中文（面板徽章用）。 */
const RUN_LABELS = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};
/** 台账里需求字段的候选键名（不同写入方可能用不同键，按序取第一个非空）。 */
const REQUIREMENT_KEYS = ['requirement', 'request', '需求'];

/** 面板文件缺失时的降级页：不漂亮但可用，且明确提示部署出了问题。 */
const FALLBACK_PANEL =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>团队看板</title></head>' +
  '<body style="font:13px/1.6 -apple-system,\'Segoe UI\',\'Microsoft YaHei\',sans-serif;padding:14px">' +
  '<h1 style="font-size:15px;margin:0 0 8px">团队看板</h1>' +
  '<p style="margin:0;color:#8a8f98">面板文件缺失（ui/panel.html 未随插件部署），请重新部署插件后重开面板。</p>' +
  '</body></html>';

/* ------------------------------ 通用小工具 ------------------------------ */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 截断并加省略号（与 swarm-ledger 的 clip 同口径）。 */
function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t;
}

/** 取结果的一行摘要：字符串取首行；对象优先 summary，否则 JSON 化。 */
function resultSummary(result) {
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

/* ------------------------------ 台账读取与看板映射 ------------------------------ */

/** 项目根：env ZCODE_WORKSPACE_ROOT 优先；宿主没展开的 ${...} 占位符视同未设置，退回 cwd。 */
function projectRoot() {
  const raw = String(process.env.ZCODE_WORKSPACE_ROOT || '').trim();
  const usable = raw && !raw.includes('${') ? raw : process.cwd();
  return resolve(usable);
}

const ROOT = projectRoot();
const LEDGER_PATH = join(ROOT, LEDGER_REL);

/** 读台账；不存在/不可读/不是合法 JSON 都返回 null（面板照常响应，绝不报错）。 */
function readLedger() {
  let raw;
  try {
    // 先读再判存在：existsSync 与 readFileSync 之间的删除竞态（另一个进程正好 rename）
    // 会让 existsSync 返回 true 而 read 抛错，这里两个失败都收敛成 null。
    raw = readFileSync(LEDGER_PATH, 'utf8');
  } catch {
    return null;
  }
  try {
    // 手改用 Windows 记事本保存的台账可能带 UTF-8 BOM，JSON.parse 会直接失败：先剥掉。
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 台账需求字段（兼容 requirement / request / 需求 三种键，只认自有键，防原型链污染）。 */
function requirementOf(ledger) {
  for (const key of REQUIREMENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(ledger, key)) continue;
    const v = ledger[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** 耗时毫秒：running 算到此刻，结束的运行算到 updated_at；时间戳坏了就 0。 */
function elapsedMs(ledger) {
  const start = Date.parse(ledger.created_at ?? '');
  const end = ledger.status === 'running' ? Date.now() : Date.parse(ledger.updated_at ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor(end - start));
}

/** 无台账/坏台账时的空看板：结构齐全，面板无需特判。 */
function noneData() {
  return {
    status: 'none',
    status_label: '无运行',
    run_id: null,
    requirement: '',
    gate: { command: '', status: null, rounds: 0 },
    cards: [],
    counts: { passed: 0, failed: 0, working: 0, reviewing: 0, rework: 0, pending: 0 },
    findings_count: 0,
    deferred_count: 0,
    agent_models: null,
    phase: 'idle',
    progress: { total: 0, settled: 0, percent: 0 },
    findings: [],
    deferred: [],
    elapsed_ms: 0,
    created_at: null,
    updated_at: null,
  };
}

/** 台账 → 面板看板数据（字段映射自己实现，不依赖台账脚本的内部函数）。 */
function boardData() {
  const ledger = readLedger();
  if (!ledger) return noneData();

  const cards = (Array.isArray(ledger.cards) ? ledger.cards : []).map((raw) => {
    const c = isPlainObject(raw) ? raw : {};
    const known = typeof c.state === 'string' && ownLookup(CARD_LABELS, c.state) ? c.state : 'pending';
    const roundNum = Number(c.round);
    const review = isPlainObject(c.review) ? c.review : null;
    const findings = Array.isArray(review?.findings) ? review.findings : [];
    return {
      id: c.id != null ? String(c.id) : '',
      title: String(c.title ?? ''),
      state: known,
      state_label: ownLookup(CARD_LABELS, known),
      round: Number.isFinite(roundNum) && roundNum >= 0 ? roundNum : 0,
      role: c.role != null ? String(c.role) : 'worker',
      // 短备注（卡片列表用）＋ 展开详情（点开卡片用）：
      note: clip(resultSummary(c.result) || String(c.error ?? ''), 80),
      // 详情：任务原文、写入范围、验收标准 —— 让面板能回答「这张卡到底在做什么」。
      task: clip(String(c.task ?? ''), 2000),
      scope: String(c.scope ?? ''),
      acceptance: clip(String(c.acceptance ?? ''), 1000),
      // 结果与审查：摘要、逐条检查项、问题清单。
      summary: clip(resultSummary(c.result), 1200),
      error: c.error == null ? '' : clip(String(c.error), 600),
      checks: Array.isArray(c.result && c.result.checks) ? c.result.checks.slice(0, 40).map((x) => clip(String(x), 400)) : [],
      changed: Array.isArray(c.result && c.result.changed) ? c.result.changed.slice(0, 40).map((x) => String(x)) : [],
      review_pass: review && typeof review.pass === 'boolean' ? review.pass : null,
      review_findings: findings.slice(0, 20).map((f) => clip(String(f), 400)),
      review_checked: Array.isArray(review?.checked) ? review.checked.slice(0, 40).map((x) => clip(String(x), 400)) : [],
      bounces: Array.isArray(c.bounces) ? c.bounces.length : 0,
      spawns: Array.isArray(c.spawns) ? c.spawns.length : 0,
      open_items: Array.isArray(c.result && c.result.open) ? c.result.open.slice(0, 20).map((x) => clip(String(x), 400)) : [],
      launched_at: c.launched_at ?? null,
      completed_at: c.completed_at ?? null,
      updated_at: c.completed_at ?? c.launched_at ?? ledger.updated_at ?? null,
    };
  });

  const counts = { passed: 0, failed: 0, working: 0, reviewing: 0, rework: 0, pending: 0 };
  for (const c of cards) {
    // 只累加已知状态键，避免任何异常状态名把计数对象写出多余键。
    if (ownLookup(counts, c.state) !== undefined) counts[c.state] += 1;
  }

  const gateRounds = Number(ledger.gate_rounds);
  const runStatus = String(ledger.status ?? 'running');

  return {
    status: runStatus,
    status_label: ownLookup(RUN_LABELS, runStatus) ?? runStatus,
    run_id: ledger.run_id ?? null,
    requirement: clip(requirementOf(ledger), 120),
    gate: {
      command: typeof ledger.gate === 'string' ? ledger.gate : '',
      // gate_status 的合法域是 'pass'/'fail'/null；台账被手改成对象/数字时按未运行处理。
      status: typeof ledger.gate_status === 'string' ? ledger.gate_status : null,
      rounds: Number.isFinite(gateRounds) && gateRounds >= 0 ? gateRounds : 0,
    },
    cards,
    counts,
    // 运行阶段：一眼看出团队现在卡在哪个环节（拆分→施工→审查→验证→收尾）。
    phase: (() => {
      if (runStatus !== 'running') return runStatus === 'completed' ? 'done' : 'stopped';
      if (counts.pending > 0 && counts.working === 0 && counts.reviewing === 0 && counts.rework === 0) return 'dispatching';
      if (counts.working > 0 || counts.rework > 0) return 'building';
      if (counts.reviewing > 0) return 'reviewing';
      if (counts.pending === 0 && counts.working === 0 && counts.reviewing === 0 && counts.rework === 0) return 'gate';
      return 'building';
    })(),
    // 进度：已结算卡数 / 总卡数（passed+failed 算结算）。
    progress: {
      total: cards.length,
      settled: counts.passed + counts.failed,
      percent: cards.length > 0 ? Math.round(((counts.passed + counts.failed) / cards.length) * 100) : 0,
    },
    findings: Array.isArray(ledger.findings) ? ledger.findings.slice(0, 30).map((f) => clip(isPlainObject(f) ? String(f.text ?? f.title ?? '') : String(f), 300)) : [],
    deferred: Array.isArray(ledger.deferred) ? ledger.deferred.slice(0, 30).map((d) => ({
      title: clip(isPlainObject(d) ? String(d.title ?? d.text ?? '') : String(d), 200),
      reason: clip(isPlainObject(d) ? String(d.summary ?? d.reason ?? '') : '', 200),
    })) : [],
    findings_count: Array.isArray(ledger.findings) ? ledger.findings.length : 0,
    deferred_count: Array.isArray(ledger.deferred) ? ledger.deferred.length : 0,
    agent_models: isPlainObject(ledger.agent_models) ? ledger.agent_models : null,
    elapsed_ms: elapsedMs(ledger),
    created_at: ledger.created_at ?? null,
    updated_at: ledger.updated_at ?? null,
  };
}

/* ------------------------------ JSON-RPC 传输 ------------------------------ */

/** RpcError：带 JSON-RPC 错误码，dispatch 里区分“方法不存在/参数错/内部错”。 */
class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.rpcCode = code;
    this.rpcData = data;
  }
}

function send(message) {
  // stdout 可能已被宿主关掉（EPIPE）：写失败只丢这一条，绝不把异常抛进请求循环。
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    /* 输出流已坏，丢弃即可 */
  }
}

/** stderr 日志：宿主把 stderr 也关掉时（Windows GUI 下常见）不能反过来把服务写崩。 */
function log(message) {
  try {
    process.stderr.write(message);
  } catch {
    /* 诊断输出失败不影响服务 */
  }
}

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** id 合法域：字符串、数字、null（对象/布尔等无法回显，按 null 处理）。 */
function isEchoableId(id) {
  return id === null || typeof id === 'string' || typeof id === 'number';
}

/** 当前连接已订阅的资源 URI（stdio 单连接，一个 Set 足够）。 */
const subscriptions = new Set();
/** 上次推送/读取时的看板指纹：内容没变就不打扰面板。 */
let lastBoardSig = null;

/**
 * 看板指纹：排除 elapsed_ms（running 时它每次调用都变），否则指纹永远不同、去重失效，
 * 每次写台账都会推一条“其实没变”的更新。其余字段都参与比较。
 * 只在“数据已交给面板”的路径（resources/read board.json 与面板首屏注入）记账，
 * 主会话的 tools/call 不记账，免得把面板该收的推送误吞。
 */
function boardSignature(data) {
  // 浅拷贝后把易变字段归零：不碰数据本身，也不会误伤同名嵌套键。
  return JSON.stringify({ ...data, elapsed_ms: 0 });
}

/**
 * 面板 HTML：读磁盘后把当前看板数据注入 `BOARD 占位符`（首屏静态快照，桥/直读都失效时用）。
 * 注入必须走函数形式：字符串替换参数会解释 $& / $' 等序列，标题里带这些字符就会把数据写坏。
 * 序列化时把 < 转义成 \u003c，防止标题里的 script 结束标签提前闭合脚本块。
 * 占位符清理必须在注入之前做完：台账标题里若恰好含 `/*@@END@@*\/`，先清后注才不会把数据抹掉。
 * 文件不存在时返回降级页，绝不把读文件失败抛给宿主。
 */
function panelHtml() {
  let tpl;
  try {
    tpl = readFileSync(PANEL_PATH, 'utf8');
  } catch {
    return FALLBACK_PANEL;
  }
  let json = 'null';
  try {
    const data = boardData();
    // 行分隔符 U+2028/U+2029 在旧引擎里会提前结束 JS 字符串，连同 < 一起转义成 \uXXXX。
    json = JSON.stringify(data)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    // 面板快照就是当前状态：记下指纹，订阅后第一次无关写入不会白推一条更新。
    lastBoardSig = boardSignature(data);
  } catch {
    json = 'null';
  }
  // 1) 模板里的数据区先换成一个不会与数据撞车的槽位；2) 清掉其余残留占位符；3) 最后注入 JSON。
  const SLOT = '\u0000@@SWARM_BOARD_DATA@@\u0000';
  const shell = tpl
    .replace(/\/\*@@BOARD@@\*\/[\s\S]*?\/\*@@END@@\*\//g, () => SLOT)
    .replace(/\/\*@@BOARD@@\*\//g, '')
    .replace(/\/\*@@END@@\*\//g, '');
  return shell.replaceAll(SLOT, () => json);
}

/**
 * MCP 内嵌看板（2026-11-22 用户方案）：把新版看板设计（分段条+大数字+可展开）
 * 以 MCP 工具结果内嵌面板的形态呈现——内嵌面板不折叠，解决 Gen UI 卡会折叠的问题。
 * 每次工具被调用时实时生成当前快照。
 */
function boardCardHtml() {
  const tplPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'board-card.html');
  let tpl;
  try {
    tpl = readFileSync(tplPath, 'utf8');
  } catch {
    return `<html><body style="font:13px system-ui;padding:12px"><p>看板模板不可用，数据：</p><pre>${JSON.stringify(boardData(), null, 2)}</pre></body></html>`;
  }
  const data = boardData();
  let json;
  try {
    json = JSON.stringify(data).replace(/</g, '\u003c');
  } catch (err) {
    json = 'null';
  }
  const html = tpl
    .replace(/\/\*@@DATA@@\*\/[\s\S]*?\/\*@@END@@\*\//, () => json)
    .replace(/\/\*@@DATA@@\*\//g, '')
    .replace(/\/\*@@END@@\*\//g, '');
  
  // 在 </body> 前注入自动刷新脚本：订阅推送 + 轮询兜底
  const autoRefresh = `
<script>
(function(){
  var DATA_URI='ui://zcode-swarm/board.json';
  var etag=null;
  var lastData=null;
  
  function applyData(d){
    if(!d||typeof d!=='object')return;
    lastData=d;
    // 用现有 render() 函数重绘（board-card.html 已有）
    if(typeof render==='function'){try{render();}catch(e){}}
  }
  
  function fetchData(){
    return new Promise(function(resolve){
      // 经父窗口 MCP 桥请求
      if(window.parent&&window.parent!==window&&typeof window.parent.postMessage==='function'){
        var id='swarm-refresh-'+Date.now();
        var timeout=setTimeout(function(){resolve(null);},4000);
        function onMsg(ev){
          var d=ev&&ev.data;
          if(!d||d.jsonrpc!=='2.0'||d.id!==id)return;
          clearTimeout(timeout);
          window.removeEventListener('message',onMsg);
          resolve(d.result);
        }
        window.addEventListener('message',onMsg);
        window.parent.postMessage({jsonrpc:'2.0',id:id,method:'resources/read',params:{uri:DATA_URI}},'*');
      }else{resolve(null);}
    });
  }
  
  function tick(){
    fetchData().then(function(d){
      if(d&&d.contents&&d.contents[0]&&d.contents[0].text){
        try{
          var data=JSON.parse(d.contents[0].text);
          var sig=JSON.stringify(data);
          if(sig!==etag){etag=sig;applyData(data);}
        }catch(e){}
      }
      setTimeout(tick,3000);
    }).catch(function(){setTimeout(tick,3000);});
  }
  
  // 启动轮询（3秒间隔）
  setTimeout(tick,3000);
})();
</script>`;
  
  return html.replace('</body>', autoRefresh+'</body>');
}

const RESOURCES = [
  {
    uri: PANEL_URI,
    name: 'panel.html',
    title: '团队看板面板',
    description: '团队看板侧栏面板页面（单文件自包含，数据经 board.json 读取）。',
    mimeType: HTML_MIME,
  },
  {
    uri: BOARD_CARD_URI,
    name: 'board.html',
    title: '团队看板（新版设计内嵌面板）',
    description: '新版看板 HTML（分段进度条+大数字+可展开卡片），实时生成当前快照。',
    mimeType: 'text/html;profile=mcp-app',
  },
  {
    uri: BOARD_URI,
    name: 'board.json',
    title: '实时看板数据',
    description: '当前项目 .swarm/ledger.json 映射出的看板数据；无台账时为 status=none。',
    mimeType: JSON_MIME,
  },
];

const TOOLS = [
  {
    name: 'swarm_board',
    title: '团队看板',
    description:
      '返回当前蜂群运行概要（run_id/状态/阶段/进度/计数）。无参数，只读；实时看板在侧栏「团队看板」面板与 Gen UI 看板卡；完整数据走 resources/read ui://zcode-swarm/board.json。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    /* MCP 内嵌新版看板（2026-11-22 用户方案）：resourceUri 指向 board.html（新版设计），
       不是 panel.html（旧侧栏设计）。每次 swarm_board 被调用，宿主内嵌渲染当前快照——
       内嵌面板不折叠，解决 Gen UI 卡会折叠的问题。 */
    _meta: { ui: { resourceUri: BOARD_CARD_URI } },
  },
];

/** 方法分发表：新增方法在这里加一行。 */
const METHODS = {
  initialize(params) {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion.trim() : '';
    return {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: true, listChanged: false },
      },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: '团队看板：swarm_board 返回运行概要（run/状态/阶段/进度/计数）；实时看板在侧栏「团队看板」面板（左侧栏图标打开）与 Gen UI 看板卡；完整数据走 resources/read ui://zcode-swarm/board.json。',
    };
  },

  ping() {
    return {};
  },

  'tools/list'() {
    return { tools: TOOLS };
  },

  'tools/call'(params) {
    if (params.name !== 'swarm_board') {
      throw new RpcError(-32602, `未知工具 ${String(params.name)}`);
    }
    const data = boardData();
    // 2026-11-20/21 双看板事故修复：本工具只回运行概要，不带 _meta.ui（避免宿主把 panel.html
    // 内嵌进聊天流）、不含 cards（避免与 Gen UI 看板卡同源重复）。主会话要数据走
    // resources/read ui://zcode-swarm/board.json。
    const brief = {
      run_id: data.run_id,
      status: data.status,
      status_label: data.status_label,
      phase: data.phase,
      progress: data.progress,
      counts: data.counts,
      hint: '实时详情看侧栏「团队看板」面板或 Gen UI 看板卡；完整数据用 resources/read ui://zcode-swarm/board.json',
    };
    let json;
    try {
      json = JSON.stringify(brief, null, 2);
    } catch (err) {
      throw new RpcError(-32603, `看板数据序列化失败：${err.message}`);
    }
    // 刻意不更新 lastBoardSig：本工具把数据交给主会话，面板并没有收到；
    // 若在这里记指纹，台账刚变又恰好被主会话查了一次，面板的 updated 推送会被误吞（只剩轮询兜底）。
    return {
      content: [{ type: 'text', text: json }],
      structuredContent: brief,
      isError: false,
    };
  },

  'resources/list'() {
    return { resources: RESOURCES };
  },

  'resources/templates/list'() {
    return { resourceTemplates: [] };
  },

  'resources/read'(params) {
    const uri = String(params.uri ?? '');
    if (uri === BOARD_CARD_URI) {
      return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: boardCardHtml() }] };
    }
    if (uri === PANEL_URI) {
      return { contents: [{ uri: PANEL_URI, mimeType: HTML_MIME, text: panelHtml() }] };
    }
    if (uri === BOARD_URI) {
      const data = boardData();
      let text;
      try {
        text = JSON.stringify(data, null, 2);
      } catch (err) {
        throw new RpcError(-32603, `看板数据序列化失败：${err.message}`);
      }
      lastBoardSig = boardSignature(data);
      return { contents: [{ uri: BOARD_URI, mimeType: JSON_MIME, text }] };
    }
    // 按 MCP 惯例：未知资源用 InvalidParams + data.uri，宿主 SDK 会映射成 ResourceNotFoundError。
    throw new RpcError(-32602, `未知资源 ${uri}`, { uri });
  },

  'resources/subscribe'(params) {
    const uri = String(params.uri ?? '');
    if (!RESOURCES.some((r) => r.uri === uri)) throw new RpcError(-32602, `未知资源 ${uri}`, { uri });
    subscriptions.add(uri);
    return {};
  },

  'resources/unsubscribe'(params) {
    const uri = String(params.uri ?? '');
    if (!RESOURCES.some((r) => r.uri === uri)) throw new RpcError(-32602, `未知资源 ${uri}`, { uri });
    subscriptions.delete(uri);
    return {};
  },

  'prompts/list'() {
    return { prompts: [] };
  },

  'logging/setLevel'() {
    return {};
  },
};

/** 请求判定：看 id 键是否出现。规范里 id 可为 null（属请求），只有完全不带 id 才是通知。 */
function hasId(msg) {
  return Object.prototype.hasOwnProperty.call(msg, 'id');
}

/**
 * 处理一条已解析的消息：请求返回响应对象，通知返回 null（静默接收）。
 * 任何异常都收敛成 JSON-RPC error，绝不上抛；非对象消息（null/标量）按 -32600 处理。
 * JSON-RPC batch 由 handleLine 先展开（见那里的说明），单条数组消息不会走到这里。
 */
function dispatch(msg) {
  if (!isPlainObject(msg)) {
    // 标量/null 没有可回显的 id，只能回 id=null 的错误。
    return errorResponse(null, -32600, '非法请求：消息必须是 JSON 对象');
  }
  const { id, method, params } = msg;
  const isRequest = hasId(msg);
  if (msg.jsonrpc !== '2.0' || typeof method !== 'string' || !isEchoableId(id)) {
    return isRequest ? errorResponse(isEchoableId(id) ? id : null, -32600, '非法请求：需要 jsonrpc=2.0 与 method') : null;
  }
  // 客户端通知（如 notifications/initialized）：静默接收，按协议不回响应。
  if (!isRequest) return null;
  try {
    // 用 hasOwnProperty 取方法：否则 constructor/toString 这类原型链名字会被误判成已有方法。
    const fn = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : null;
    if (typeof fn !== 'function') throw new RpcError(-32601, `未知方法 ${method}`);
    const result = fn(isPlainObject(params) ? params : {});
    return { jsonrpc: '2.0', id, result: result ?? {} };
  } catch (err) {
    const code = err && Number.isInteger(err.rpcCode) ? err.rpcCode : -32603;
    return errorResponse(id, code, err && err.message ? err.message : String(err), err?.rpcData);
  }
}

/* ------------------------------ 台账变更推送（尽力而为） ------------------------------ */

let watcher = null;
let notifyTimer = null;
let watchRetryTimer = null;
/** 已挂 watcher 的目录身份（dev:ino:birthtime）；目录被删/重建后身份变了，必须重挂。 */
let watchedDirKey = null;
let shuttingDown = false;

/** 关掉 watcher（句柄留着下次 retry 重建）。 */
function stopWatcher() {
  const w = watcher;
  watcher = null;
  watchedDirKey = null;
  if (!w) return;
  try {
    w.close();
  } catch {
    /* 关不掉也不影响服务 */
  }
}

/** 目录身份：不存在/无权限时返回 null。ino 与 birthtime 一起用：部分文件系统 ino 恒为 0。 */
function dirKey(path) {
  try {
    const st = statSync(path);
    return `${st.dev}:${st.ino}:${st.birthtimeMs}`;
  } catch {
    return null;
  }
}

/** 监视 ledger.json 所在目录；目录还不存在（尚未开工）时静默等待，由定时器重试。 */
function ensureWatcher() {
  if (shuttingDown) return;
  const dir = dirname(LEDGER_PATH);
  const current = dirKey(dir);
  if (!current) {
    // 目录被删（归档/换项目）或还不存在：旧 watcher 盯的是旧 inode，拆掉等重试。
    stopWatcher();
    return;
  }
  if (watcher && current === watchedDirKey) return;
  stopWatcher();
  let w;
  try {
    // persistent: false —— 不让 watcher 拖住宿主关闭；stdin 才是进程的主命脉。
    w = watch(dir, { persistent: false }, (eventType, filename) => {
      // Windows 下事件可能带 ledger.json 或其原子写用的 tmp 名：只认台账本体（精确 basename，
      // 不用 endsWith——否则别的项目文件 my-ledger.json、ledger.json.bak 也会触发）。
      // 有的平台 rename 事件不给 filename（null）：保守起见当作可能相关，交给去抖后读内容比对。
      if (filename != null && basename(String(filename)) !== 'ledger.json') return;
      scheduleNotify();
    });
  } catch {
    watchedDirKey = null;
    return;
  }
  watcher = w;
  watchedDirKey = current;
  w.on('error', () => {
    if (watcher === w) stopWatcher();
  });
  w.once('close', () => {
    if (watcher === w) stopWatcher();
  });
}

/** 合并短时间内的多次写事件，读完台账确认内容真变了再通知。 */
function scheduleNotify() {
  if (notifyTimer || shuttingDown) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    if (shuttingDown || !subscriptions.has(BOARD_URI)) return; // 没客户端订阅看板就什么也不做
    const data = boardData();
    let sig;
    try {
      sig = boardSignature(data);
    } catch {
      return;
    }
    if (sig === lastBoardSig) return;
    lastBoardSig = sig;
    send({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: BOARD_URI } });
  }, 150);
  notifyTimer.unref?.();
}

/** 定期检查/挂上 watcher：.swarm 目录可能在本服务启动后才由 /swarm 创建，也可能被归档重建。 */
function startWatchRetry() {
  watchRetryTimer = setInterval(ensureWatcher, 2000);
  watchRetryTimer.unref?.();
}

/* ------------------------------ 主循环与生命周期 ------------------------------ */

let rl = null;
let resolveShutdown = null;
const shutdownPromise = new Promise((resolve) => {
  resolveShutdown = resolve;
});

/** 处理一行输入：单条消息或（兼容地）JSON-RPC batch。 */
function handleLine(line) {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    // 解析失败按协议回 parse error；id 未知用 null（不匹配任何请求 id，面板会忽略）。
    send(errorResponse(null, -32700, '解析失败：不是合法 JSON'));
    return;
  }
  try {
    if (Array.isArray(msg)) {
      // batch：逐条处理，全部是通知时按协议不回响应。上限防止单行放大攻击。
      if (msg.length === 0) {
        send(errorResponse(null, -32600, '非法请求：空的批量请求'));
        return;
      }
      if (msg.length > 100) {
        send(errorResponse(null, -32600, '非法请求：批量请求过大'));
        return;
      }
      const out = [];
      for (const item of msg) {
        const res = dispatch(item);
        if (res) out.push(res);
      }
      if (out.length) send(out);
      return;
    }
    const res = dispatch(msg);
    if (res) send(res);
  } catch (err) {
    log(`[swarm-board] 请求处理异常：${err?.stack ?? err}\n`);
  }
}

/**
 * 清理一切资源并放主循环返回；宿主（plugin-host）等在 main() 上，能据此正常收尾。
 * reason='stdin'（管道正常读完）：不硬退，等 stdout 冲刷完、事件循环自然排空（3s 兜底）。
 * reason='signal'（宿主要求退出）：stdin 句柄可能还活着，给一次短冲刷窗口后强制退出，避免挂住。
 */
function shutdown(reason = 'stdin') {
  if (shuttingDown) return;
  shuttingDown = true;
  stopWatcher();
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  if (watchRetryTimer) {
    clearInterval(watchRetryTimer);
    watchRetryTimer = null;
  }
  try {
    rl?.close();
  } catch {
    /* 关不掉不影响退出 */
  }
  rl = null;
  // stdout 里排队的数据（大面板 HTML）还没冲刷完就硬退会被截断：先给冲刷窗口，再兜底退出。
  const forceExit = setTimeout(() => process.exit(0), reason === 'stdin' ? 3000 : 300);
  if (reason === 'stdin') forceExit.unref(); // 正常关闭：事件循环排空后自己退出，不必等满 3s
  resolveShutdown?.();
}

/**
 * 服务入口：宿主 plugin-host 形态导入后 await main()，裸 node 直接运行也走这里。
 * 只在这里挂进程级监听/副作用，模块被 import 时不产生任何运行时副作用。
 */
async function main() {
  if (rl || shuttingDown) return shutdownPromise; // 重复调用：等同一个生命周期，不重复挂监听
  subscriptions.clear();
  lastBoardSig = null;

  rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', handleLine);
  rl.on('close', () => shutdown('stdin'));
  // readline 会把输入流的 error 转发成自身 'error'；不监听会变成未捕获异常（进程虽被兜底但不干净）。
  rl.on('error', (err) => {
    log(`[swarm-board] 输入解析异常：${err?.stack ?? err}\n`);
    shutdown('signal');
  });

  // 输入流坏掉（宿主断开/管道断裂）：readline 可能等不到 close，直接按关闭处理。
  process.stdin.on('error', (err) => {
    log(`[swarm-board] stdin 异常：${err?.stack ?? err}\n`);
    shutdown('signal');
  });
  // stdout 被宿主关掉时写会抛 EPIPE：吞掉并停止推送，绝不让服务崩掉。
  process.stdout.on('error', (err) => {
    if (err?.code !== 'EPIPE') log(`[swarm-board] stdout 异常：${err?.stack ?? err}\n`);
    shutdown('signal');
  });

  // 兜底：任何漏网异常只记 stderr，绝不让面板服务崩掉。
  process.on('uncaughtException', (err) => {
    log(`[swarm-board] 未捕获异常：${err?.stack ?? err}\n`);
  });
  process.on('unhandledRejection', (err) => {
    log(`[swarm-board] 未处理的 rejection：${err?.stack ?? err}\n`);
  });
  // 信号：走统一清理（不直接 exit，先让 stdout 冲刷），由 shutdown 的短定时器兜底退出。
  const onSignal = () => shutdown('signal');
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  ensureWatcher();
  startWatchRetry();
  log(`[swarm-board] 就绪：项目根 ${ROOT}，台账 ${LEDGER_PATH}\n`);

  await shutdownPromise;
}

export { main };

// 裸 node 直接运行（含测试探针）：argv[1] 就是本文件时自启动。
// plugin-host 形态（argv 里带 __zcode-plugin-host）由宿主显式调用 main()，这里绝不重复自启动
// （宿主先 import 本文件、之后才改写 process.argv，留一道显式护栏更稳）。
const PLUGIN_HOST_FLAG = '__zcode-plugin-host';
if (
  process.argv[1] &&
  !process.argv.includes(PLUGIN_HOST_FLAG) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
