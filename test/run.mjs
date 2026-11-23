#!/usr/bin/env node
/**
 * zcode-swarm 自验证：node test/run.mjs
 * 零依赖；缺 Chrome/TypeScript 的单项打印 SKIP（退出码 3）不算失败，其余全绿才退出 0。
 * 覆盖：设置契约（插件只配 rework_rounds、show 报 5 角色实际模型与来源、已删命令返回未知命令）、
 * validate 只校任务卡（重叠范围拒绝）、render/ensure 幂等、工作流模板类型检查、
 * 默认作用域写入物化（不污染全局 default）、v1 落盘迁移、宿主设置层只读（嵌套/扁平键、项目作用域免疫、不物化）、
 * v2 台账（init 契约/状态机/failed→working 接管重做/渲染注入安全/路径消毒/发现与门禁/recover/旧台账归档/agent_models 元数据）、
 * 团队看板面板服务（MCP 握手与资源、看板字段映射与坏台账降级、面板 HTML 与无头渲染、错误请求不拖垮进程、
 * 推送去抖与同内容重写不推、首屏占位符注入安全、BOM 台账、原型链状态防护、tools/call 不吞推送、非对象消息回 -32600）、
 * 兜底工作流在项目作用域下也刷新、戳行正确但正文漂移时 ensure 重写全文、hooks 命令可移植性静态 lint。
 * 端到端全链（e2e-full-cycle）：show → validate → init → 状态机（含两步返工）→ bounce 上限 → finding → spawn →
 * gate → fixer → finish → report → render board/report，串起 /swarm 的实际命令序列。
 * 每个线上事故都应在此落一条回归用例（纪律 S3）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// SWARM_TEST_CFG 仅供反向验证：把脚本指向临时目录里的旧逻辑副本，确认回归用例确实会红。
const CFG = process.env.SWARM_TEST_CFG || join(REPO, 'scripts', 'swarm-config.mjs');
// SWARM_TEST_LEDGER 仅供反向验证：指向旧版台账脚本副本，确认新增回归用例确实会红。
const LEDGER = process.env.SWARM_TEST_LEDGER || join(REPO, 'scripts', 'swarm-ledger.mjs');
const FIX = join(HERE, 'fixtures');
const WORKFLOW = join(REPO, 'workflows', 'zcode-swarm.dwf.ts');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: ok === true, skipped: ok === 'skip', detail });
  console.log(`${ok === 'skip' ? 'SKIP' : ok ? 'PASS' : 'FAIL'} ${name}${ok === true || ok === 'skip' ? '' : ` — ${detail}`}`);
}

function home(settingsJson) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-test-'));
  if (settingsJson !== null) {
    const settingsDir = join(dir, '.zcode', 'zcode-swarm');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, 'settings.json'), settingsJson, 'utf8');
  }
  return dir;
}

function cfg(args, { stdin, homeDir, cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CFG, ...args], {
    input: stdin,
    encoding: 'utf8',
    cwd: cwd || homeDir,
    env: { ...process.env, USERPROFILE: homeDir, SWARM_PROJECT: '', ZCODE_GEN_UI_OUTPUT_ROOT: '', ...env },
  });
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);
const LEGACY = readFileSync(join(FIX, 'settings-legacy.json'), 'utf8');
const CARDS = readFileSync(join(FIX, 'cards.json'), 'utf8');

// ─── 设置契约（插件不再配置模型：只有 rework_rounds + 5 个角色的实际模型来源） ───

// 1 show 报告 5 个角色 + 返工轮数；没有任何档位字样
{
  const h = home(null);
  const r = cfg(['show'], { homeDir: h });
  check(
    'show reports 5 roles and no tiers',
    r.status === 0 &&
      r.stdout.includes('团队角色模型') &&
      ['planner', 'architect', 'builder', 'reviewer', 'fixer'].every((role) => r.stdout.includes(role)) &&
      !/light|strong|hard/i.test(r.stdout) &&
      !r.stdout.includes('档位'),
    r.stdout + r.stderr,
  );
  rmSync(h, { recursive: true, force: true });
}

// 2 show --json 暴露 roles 数组（role/model/source 三字段）
{
  const h = home(null);
  const r = cfg(['show', '--json'], { homeDir: h });
  let doc = null;
  try { doc = JSON.parse(r.stdout); } catch { /* 下面断言会失败 */ }
  check(
    'show --json exposes role models',
    r.status === 0 &&
      doc &&
      Array.isArray(doc.roles) &&
      doc.roles.length === 5 &&
      doc.roles.every((item) => typeof item.role === 'string' && typeof item.model === 'string' && ['宿主设置', '继承默认'].includes(item.source)) &&
      (doc.settings.models === undefined),
    r.stdout + r.stderr,
  );
  rmSync(h, { recursive: true, force: true });
}

// 3 无宿主覆盖时全部角色都是「继承默认」
{
  const h = home(null);
  const r = cfg(['show', '--json'], { homeDir: h });
  let doc = null;
  try { doc = JSON.parse(r.stdout); } catch { /* 断言失败 */ }
  check(
    'no host overrides means all roles inherit',
    r.status === 0 && doc && doc.roles.every((item) => item.source === '继承默认' && item.model === 'inherit'),
    r.stdout + r.stderr,
  );
  rmSync(h, { recursive: true, force: true });
}

// 4 set 只接受 rework_rounds（旧 models 字段被丢弃并提示，不报错）
{
  const h = home(null);
  const r = cfg(['set', '--stdin'], { homeDir: h, stdin: JSON.stringify({ models: { light: 'inherit' }, review_model: 'strong', rework_rounds: 1 }) });
  const shown = cfg(['show', '--json'], { homeDir: h });
  let doc = null;
  try { doc = JSON.parse(shown.stdout); } catch { /* 断言失败 */ }
  check(
    'set drops legacy model fields and keeps rounds',
    r.status === 0 &&
      r.stderr.includes('已废弃') &&
      doc &&
      doc.settings.models === undefined &&
      doc.settings.review_model === undefined &&
      doc.settings.rework_rounds === 1,
    r.stdout + r.stderr + shown.stdout,
  );
  rmSync(h, { recursive: true, force: true });
}

// 5 set 拒绝越界的 rework_rounds，且绝不落盘
{
  const h = home(null);
  const before = existsSync(join(h, '.zcode', 'zcode-swarm', 'settings.json')) ? readFileSync(join(h, '.zcode', 'zcode-swarm', 'settings.json'), 'utf8') : '';
  const r = cfg(['set', '--stdin'], { homeDir: h, stdin: JSON.stringify({ rework_rounds: 9 }) });
  const after = existsSync(join(h, '.zcode', 'zcode-swarm', 'settings.json')) ? readFileSync(join(h, '.zcode', 'zcode-swarm', 'settings.json'), 'utf8') : '';
  check('set rejects out-of-range rounds', r.status === 2 && r.stderr.includes('0 到 5') && before === after, r.stderr);
  rmSync(h, { recursive: true, force: true });
}

// 6 宿主插件配置只剩 reworkRounds 生效（旧的模型键被忽略）
{
  const h = home(null);
  mkdirSync(join(h, '.zcode', 'cli'), { recursive: true });
  writeFileSync(
    join(h, '.zcode', 'cli', 'config.json'),
    JSON.stringify({ plugins: { options: { 'zcode-swarm': { defaultStrongModel: 'magpie/group/worker', reworkRounds: 3 } } } }),
    'utf8',
  );
  const r = cfg(['show', '--json'], { homeDir: h });
  let doc = null;
  try { doc = JSON.parse(r.stdout); } catch { /* 断言失败 */ }
  check(
    'host layer only carries rounds now',
    r.status === 0 && doc && doc.settings.rework_rounds === 3 && doc.settings.models === undefined,
    r.stdout + r.stderr,
  );
  rmSync(h, { recursive: true, force: true });
}

// 7 validate 只校任务卡（不接受 --models-file，也不再输出 resolved）
{
  const h = home(null);
  const r = cfg(['validate', '--stdin', '--models-file', join(REPO, 'test', 'fixtures', 'cards.json')], { homeDir: h, stdin: CARDS });
  let doc = null;
  try { doc = JSON.parse(r.stdout); } catch { /* 断言失败 */ }
  check(
    'validate no longer resolves models',
    r.status === 0 && doc && Array.isArray(doc.cards) && doc.resolved === undefined && doc.healed === undefined,
    r.stdout + r.stderr,
  );
  rmSync(h, { recursive: true, force: true });
}

// 8 validate 拒绝重叠写入范围（任务卡纪律仍在）
{
  const h = home(null);
  const r = cfg(['validate', '--stdin'], {
    homeDir: h,
    stdin: JSON.stringify({ cards: [
      { title: 'a', task: 'x', scope: 'src/a/', acceptance: 'ok', role: 'r', model: 'strong' },
      { title: 'b', task: 'y', scope: 'src/a/', acceptance: 'ok', role: 'r', model: 'strong' },
    ] }),
  });
  check('validate rejects overlapping scopes', r.status === 2 && r.stderr.includes('写入范围重叠'), r.stderr);
  rmSync(h, { recursive: true, force: true });
}

// 9 已删除的命令必须是未知命令（退出码 2），防止旧文档误导
{
  const h = home(null);
  const results = ['tier', 'preflight', 'card', 'review-card', 'lineup'].map((cmd) => cfg([cmd, 'x', 'y'], { homeDir: h }));
  check(
    'removed model commands are gone',
    results.every((r) => r.status === 2),
    results.map((r) => `${r.status}:${r.stderr.slice(0, 60)}`).join(' | '),
  );
  rmSync(h, { recursive: true, force: true });
}

// 10 ensure 幂等：二次运行输出「已是最新」
{
  const h = home(null);
  const first = cfg(['ensure'], { homeDir: h });
  const again = cfg(['ensure'], { homeDir: h });
  check('ensure is idempotent', first.status === 0 && again.status === 0 && again.stderr.includes('已是最新'), again.stderr);
  rmSync(h, { recursive: true, force: true });
}


/* ------------------------------ v2 台账回归（swarm-ledger.mjs） ------------------------------ */

/** 临时项目根：每个用例独占一个，互不共享台账状态。 */
function tmpProject() {
  return mkdtempSync(join(tmpdir(), 'swarm-ledger-'));
}

/** 调台账脚本；--project 隔离台账根，显式清空会话/可视化环境避免用例互染。 */
function ledger(args, { project, stdin, env = {} } = {}) {
  const argv = [LEDGER, ...args];
  if (project) argv.push('--project', project);
  return spawnSync(process.execPath, argv, {
    input: stdin,
    encoding: 'utf8',
    cwd: project || REPO,
    env: { ...process.env, SWARM_PROJECT: '', ZCODE_GEN_UI_OUTPUT_ROOT: '', ZCODE_SESSION_ID: '', ...env },
  });
}

const ledgerPathOf = (project) => join(project, '.swarm', 'ledger.json');
const ledgerJson = (project) => JSON.parse(readFileSync(ledgerPathOf(project), 'utf8'));
const ledgerInit = (project, input) => ledger(['init', '--stdin'], { project, stdin: JSON.stringify(input) });
const cardUpdate = (project, id, patch) => ledger(['update', String(id), '--stdin'], { project, stdin: JSON.stringify(patch) });
const dirKey = (dir) => resolve(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 单用例执行壳：用例内部异常也记成 FAIL，绝不让一条用例炸掉整个 runner。 */
function caseCheck(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn() || {};
    ok = r.ok === true;
    detail = r.detail || '';
  } catch (err) {
    detail = `异常：${err && err.stack ? err.stack : err}`;
  }
  check(name, ok, detail);
}

// 15 台账 init 契约：gate 允许空串；缺 gate 或 gate 非字符串仍拒绝（退出码 2）
caseCheck('ledger-init-gate', () => {
  const dirs = [tmpProject(), tmpProject(), tmpProject()];
  const fails = [];
  try {
    const [emptyDir, missingDir, nonStrDir] = dirs;
    const empty = ledgerInit(emptyDir, { requirement: '无验证命令', cards: [{ title: '卡一' }], gate: '' });
    if (empty.status !== 0) fails.push(`空 gate 应初始化成功，实际退出码 ${empty.status}：${empty.stderr}`);
    else if (ledgerJson(emptyDir).gate !== '') fails.push(`空 gate 落账后应为 ""，实际 ${JSON.stringify(ledgerJson(emptyDir).gate)}`);
    const missing = ledgerInit(missingDir, { requirement: '缺 gate', cards: [{ title: '卡一' }] });
    if (missing.status !== 2 || !missing.stderr.includes('缺少 gate')) {
      fails.push(`缺 gate 应退出码 2 并报缺少 gate，实际 ${missing.status}：${missing.stderr}`);
    }
    const nonStr = ledgerInit(nonStrDir, { requirement: 'gate 非字符串', cards: [{ title: '卡一' }], gate: 123 });
    if (nonStr.status !== 2 || !nonStr.stderr.includes('缺少 gate')) {
      fails.push(`gate 非字符串应退出码 2 并报缺少 gate，实际 ${nonStr.status}：${nonStr.stderr}`);
    }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});

// 16 台账 init 可选元数据：传了就原样落账，没传就不该凭空出现这些键
caseCheck('ledger-init-metadata', () => {
  const dirs = [tmpProject(), tmpProject()];
  const fails = [];
  try {
    const [withDir, withoutDir] = dirs;
    const meta = {
      agent_models: { resolved: [{ role: 'builder', model: 'magpie/opendesign/deepseek-v4.1-flash-eco$max', source: '宿主设置' }] },
      rework_rounds: 2,
    };
    const r = ledgerInit(withDir, { requirement: '带元数据', cards: [{ title: 'm' }], gate: 'npm test', ...meta });
    if (r.status !== 0) fails.push(`带元数据 init 应成功，实际 ${r.status}：${r.stderr}`);
    else {
      const l = ledgerJson(withDir);
      if (JSON.stringify(l.agent_models) !== JSON.stringify(meta.agent_models)) {
        fails.push(`agent_models 未原样落账：${JSON.stringify(l.agent_models)}`);
      }
      if (l.rework_rounds !== meta.rework_rounds) fails.push(`rework_rounds 未落账：${JSON.stringify(l.rework_rounds)}`);
    }
    const bare = ledgerInit(withoutDir, { requirement: '不带元数据', cards: [{ title: 'b' }], gate: '' });
    if (bare.status !== 0) fails.push(`不带元数据 init 应成功，实际 ${bare.status}：${bare.stderr}`);
    else {
      const l2 = ledgerJson(withoutDir);
      for (const key of ['agent_models', 'rework_rounds']) {
        if (Object.prototype.hasOwnProperty.call(l2, key)) fails.push(`未传 ${key} 时台账不应有该键`);
      }
    }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});

// 17 卡状态机：合法链路全通、非法直转被拒、pending 可直接 failed
caseCheck('ledger-state-machine', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: '状态机', cards: [{ title: '主卡' }, { title: '废卡' }], gate: 'echo ok' });
    if (init.status !== 0) return { ok: false, detail: `init 失败（${init.status}）：${init.stderr}` };
    const run = (id, patch, expect, label) => {
      const r = cardUpdate(dir, id, patch);
      if (r.status !== expect) {
        fails.push(`${label}：期望退出码 ${expect}，实际 ${r.status}（${(r.stderr || r.stdout || '').trim()}）`);
      }
    };
    run(1, { state: 'working' }, 0, 'pending→working');
    run(1, { state: 'reviewing' }, 0, 'working→reviewing');
    run(1, { state: 'working' }, 2, 'reviewing→working 应被拒');
    run(1, { state: 'rework' }, 0, 'reviewing→rework');
    const afterRework = ledgerJson(dir).cards.find((c) => c.id === '1');
    if (afterRework.round !== 1) fails.push(`reviewing→rework 应自动 round=1，实际 ${afterRework.round}`);
    run(1, { state: 'working' }, 0, 'rework→working');
    run(1, { state: 'reviewing' }, 0, 'working→reviewing');
    run(1, { state: 'passed' }, 0, 'reviewing→passed');
    run(1, { state: 'working' }, 2, 'passed→working 应被拒（终态）');
    run(2, { state: 'failed', error: '需求变更' }, 0, 'pending→failed');
    const states = ledgerJson(dir).cards.map((c) => c.state);
    if (states.join(',') !== 'passed,failed') fails.push(`终态应为 passed,failed，实际 ${states.join(',')}`);
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 18 render 注入安全：标题含 $& / $' 也不能被当作替换序列，DATA 仍可 JSON.parse
caseCheck('ledger-render-dollar-safety', () => {
  const dir = tmpProject();
  const uiRoot = tmpProject();
  const fails = [];
  const title = "cost $& price $'q'";
  try {
    const init = ledgerInit(dir, { requirement: '渲染注入', cards: [{ title, task: 't' }], gate: '' });
    if (init.status !== 0) return { ok: false, detail: `init 失败（${init.status}）：${init.stderr}` };
    const upd = cardUpdate(dir, 1, { state: 'working' });
    if (upd.status !== 0) fails.push(`状态更新失败（${upd.status}）：${upd.stderr}`);
    const render = ledger(['render', 'board'], { project: dir, env: { ZCODE_GEN_UI_OUTPUT_ROOT: uiRoot, ZCODE_SESSION_ID: 'sess1234' } });
    if (render.status !== 0) return { ok: false, detail: `render board 失败（${render.status}）：${render.stderr}` };
    const runId = ledgerJson(dir).run_id;
    const out = join(uiRoot, 'zcode-swarm', 'sess1234', `swarm-board-${runId}.html`);
    if (!existsSync(out)) fails.push(`未生成看板文件：${out}`);
    else {
      const html = readFileSync(out, 'utf8');
      if (html.includes('/*@@DATA@@*/') || html.includes('/*@@END@@*/')) fails.push('输出里残留 DATA 占位符');
      const line = html
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.startsWith('var DATA = '));
      if (!line) fails.push('没找到 DATA 赋值行');
      else {
        let data = null;
        try {
          data = JSON.parse(line.slice('var DATA = '.length).replace(/;\s*$/, ''));
        } catch (err) {
          fails.push(`DATA 不是合法 JSON：${err.message}`);
        }
        if (data && data.cards && data.cards[0] && data.cards[0].title !== title) {
          fails.push(`卡标题被替换：${JSON.stringify(data.cards[0].title)}`);
        }
      }
    }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(uiRoot, { recursive: true, force: true });
  }
});

// 19 原型污染：stdin 里的 __proto__ 不能写进台账，后续命令照常可用
caseCheck('ledger-proto-pollution', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: '原型污染', cards: [{ title: 'p' }], gate: '' });
    if (init.status !== 0) return { ok: false, detail: `init 失败（${init.status}）：${init.stderr}` };
    // 用原始 JSON 文本，避免 JS 对象字面量里的 __proto__ 语义干扰。
    // 同时带 constructor 键：绕过 __proto__ 那条守卫后它会作为普通键写进卡对象，能在台账文件里留下痕迹，
    // 这样这条用例才能真的抓住「删掉守卫」的回归（单靠 __proto__ 只会改对象原型，文件里看不到）。
    const dirty = ledger(['update', '1', '--stdin'], {
      project: dir,
      stdin: '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"state":"working"}',
    });
    // 契约允许状态转移成功或失败，但绝不能让污染字段落进台账
    if (dirty.status !== 0 && dirty.status !== 2) fails.push(`__proto__ 更新出现意外退出码 ${dirty.status}：${dirty.stderr}`);
    const raw = readFileSync(ledgerPathOf(dir), 'utf8');
    if (raw.includes('polluted')) fails.push('台账文件里出现了 polluted 字段');
    if (raw.includes('"constructor"')) fails.push('台账文件里出现了本不该有的 constructor 键');
    for (const args of [['status'], ['board'], ['report']]) {
      const r = ledger(args, { project: dir });
      if (r.status !== 0) fails.push(`${args[0]} 在污染输入后应正常运行，实际 ${r.status}：${r.stderr}`);
      if (`${r.stdout}${r.stderr}`.includes('polluted')) fails.push(`${args[0]} 输出里出现了 polluted`);
    }
    // 契约允许这条脏输入整体成功或失败，按台账实际状态推进一步合法转移，确保后续命令仍可用
    const state = ledgerJson(dir).cards.find((c) => c.id === '1').state;
    const nextState = state === 'pending' ? 'working' : state === 'working' ? 'reviewing' : null;
    if (nextState) {
      const next = cardUpdate(dir, 1, { state: nextState });
      if (next.status !== 0) fails.push(`污染输入后的合法更新应成功，实际 ${next.status}：${next.stderr}`);
    } else {
      fails.push(`污染输入后卡状态异常：${state}`);
    }
    const readBack = ledger(['status'], { project: dir });
    if (readBack.status !== 0 || !readBack.stdout.includes('#1[')) {
      fails.push(`status 读回失败（${readBack.status}）：${(readBack.stdout + readBack.stderr).trim()}`);
    }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 20 run_id 消毒：被篡改成 ../../evil 后 render 仍落在 <root>/zcode-swarm/<session>/
caseCheck('ledger-runid-sanitize', () => {
  const dir = tmpProject();
  const uiRoot = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: '路径消毒', cards: [{ title: 't' }], gate: '' });
    if (init.status !== 0) return { ok: false, detail: `init 失败（${init.status}）：${init.stderr}` };
    const ledgerObj = ledgerJson(dir);
    ledgerObj.run_id = '../../evil';
    writeFileSync(ledgerPathOf(dir), `${JSON.stringify(ledgerObj, null, 2)}\n`, 'utf8');
    const render = ledger(['render', 'board'], { project: dir, env: { ZCODE_GEN_UI_OUTPUT_ROOT: uiRoot, ZCODE_SESSION_ID: 'sess1234' } });
    if (render.status !== 0) return { ok: false, detail: `run_id 被篡改后 render 应仍成功，实际 ${render.status}：${render.stderr}` };
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(uiRoot);
    const rel = files.map((p) => relative(uiRoot, p).replace(/\\/g, '/'));
    const expected = 'zcode-swarm/sess1234/swarm-board-evil.html';
    if (!rel.includes(expected)) fails.push(`输出文件应只有 ${expected}，实际 ${rel.join(', ') || '无'}`);
    if (rel.some((p) => p.startsWith('..') || p.includes('/evil/') || p.startsWith('zcode-swarm/evil.html'))) {
      fails.push(`出现目录穿越痕迹：${rel.join(', ')}`);
    }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(uiRoot, { recursive: true, force: true });
  }
});

// 21 finding/deferred/gate/fixer：数组落账正确，report 如实反映
caseCheck('ledger-finding-deferred-gate-fixer', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: '发现与门禁', cards: [{ title: 'f' }], gate: 'echo hi' });
    if (init.status !== 0) return { ok: false, detail: `init 失败（${init.status}）：${init.stderr}` };
    const finding = ledger(['finding', '--stdin'], { project: dir, stdin: JSON.stringify({ text: '发现一', card_id: '1' }) });
    if (finding.status !== 0) fails.push(`finding 失败（${finding.status}）：${finding.stderr}`);
    const deferred = ledger(['finding', '--stdin'], { project: dir, stdin: JSON.stringify({ text: '遗留一', summary: '原因', deferred: true }) });
    if (deferred.status !== 0) fails.push(`deferred finding 失败（${deferred.status}）：${deferred.stderr}`);
    const l1 = ledgerJson(dir);
    if ((l1.findings || []).length !== 1 || l1.findings[0].text !== '发现一' || String(l1.findings[0].card_id) !== '1') {
      fails.push(`findings 数组不对：${JSON.stringify(l1.findings)}`);
    }
    if ((l1.deferred || []).length !== 1 || l1.deferred[0].text !== '遗留一') {
      fails.push(`deferred 数组不对：${JSON.stringify(l1.deferred)}`);
    }
    // 收尾硬闸（0.4.5）：gate 前须全部卡到终态（本用例只有 1 张卡）
    for (const st of ['working', 'reviewing', 'passed']) {
      const u = cardUpdate(dir, 1, { state: st });
      if (u.status !== 0) fails.push(`卡 1 → ${st} 失败（${u.status}）：${u.stderr}`);
    }
    const gate = ledger(['gate', 'pass'], { project: dir });
    if (gate.status !== 0) fails.push(`gate pass 失败（${gate.status}）：${gate.stderr}`);
    const fixer = ledger(['fixer', '--stdin'], { project: dir, stdin: JSON.stringify({ summary: '修好了', files: ['a.mjs'] }) });
    if (fixer.status !== 0) fails.push(`fixer 失败（${fixer.status}）：${fixer.stderr}`);
    const l2 = ledgerJson(dir);
    if (l2.gate_status !== 'pass') fails.push(`gate_status 应为 pass，实际 ${JSON.stringify(l2.gate_status)}`);
    if (!Array.isArray(l2.fixer_changes) || l2.fixer_changes.length !== 1 || l2.fixer_changes[0].summary !== '修好了') {
      fails.push(`fixer_changes 不对：${JSON.stringify(l2.fixer_changes)}`);
    }
    const finish = ledger(['finish', 'completed'], { project: dir });
    if (finish.status !== 0) fails.push(`finish completed 失败（${finish.status}）：${finish.stderr}`);
    const report = ledger(['report'], { project: dir });
    if (report.status !== 0) fails.push(`report 失败（${report.status}）：${report.stderr}`);
    for (const needle of ['发现一', '遗留一', '通过（第 1 轮）', '修好了']) {
      if (!report.stdout.includes(needle)) fails.push(`report 缺少 "${needle}"`);
    }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 22 recover：running 台账时提示走 stdout；--quiet 时 stdout 必须为空（钩子只读 stdout）
caseCheck('ledger-recover-stdout', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: '恢复提示', cards: [{ title: 'r' }], gate: '' });
    if (init.status !== 0) return { ok: false, detail: `init 失败（${init.status}）：${init.stderr}` };
    const upd = cardUpdate(dir, 1, { state: 'working' });
    if (upd.status !== 0) fails.push(`状态更新失败（${upd.status}）：${upd.stderr}`);
    const noisy = ledger(['recover'], { project: dir });
    if (noisy.status !== 0) fails.push(`recover 退出码应为 0，实际 ${noisy.status}`);
    if (!noisy.stdout.includes('/swarm resume')) fails.push(`recover stdout 应提示 /swarm resume，实际 ${JSON.stringify(noisy.stdout)}`);
    const quiet = ledger(['recover', '--quiet'], { project: dir });
    if (quiet.status !== 0) fails.push(`recover --quiet 退出码应为 0，实际 ${quiet.status}`);
    if (quiet.stdout.trim() !== '') fails.push(`recover --quiet 的 stdout 应为空，实际 ${JSON.stringify(quiet.stdout)}`);
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 23 旧台账归档：completed 台账被新 init 覆盖前先落 artifacts/<旧run_id>/ledger-final.json
caseCheck('ledger-archive-old-run', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const first = ledgerInit(dir, { requirement: '第一轮', cards: [{ title: 'a' }], gate: '' });
    if (first.status !== 0) return { ok: false, detail: `首个 init 失败（${first.status}）：${first.stderr}` };
    const oldId = ledgerJson(dir).run_id;
    // 收尾硬闸（0.4.5）：completed 前须全部卡到终态
    const settle = cardUpdate(dir, 1, { state: 'working' });
    if (settle.status !== 0) fails.push(`卡 1 → working 失败：${settle.stderr}`);
    const settle2 = cardUpdate(dir, 1, { state: 'reviewing' });
    if (settle2.status !== 0) fails.push(`卡 1 → reviewing 失败：${settle2.stderr}`);
    const settle3 = cardUpdate(dir, 1, { state: 'passed' });
    if (settle3.status !== 0) fails.push(`卡 1 → passed 失败：${settle3.stderr}`);
    const finish = ledger(['finish', 'completed'], { project: dir });
    if (finish.status !== 0) fails.push(`finish completed 失败（${finish.status}）：${finish.stderr}`);
    const second = ledgerInit(dir, { requirement: '第二轮', cards: [{ title: 'b' }], gate: '' });
    if (second.status !== 0) return { ok: false, detail: `再次 init 失败（${second.status}）：${second.stderr}` };
    const archived = join(dir, '.swarm', 'artifacts', oldId, 'ledger-final.json');
    if (!existsSync(archived)) fails.push(`旧台账未归档到 ${archived}`);
    else {
      const body = JSON.parse(readFileSync(archived, 'utf8'));
      if (body.run_id !== oldId) fails.push(`归档 run_id 不对：${body.run_id}`);
      if (body.requirement !== '第一轮') fails.push(`归档需求不对：${body.requirement}`);
      if (body.status !== 'completed') fails.push(`归档状态不对：${body.status}`);
    }
    if (ledgerJson(dir).requirement !== '第二轮') fails.push(`新台账未生效：${ledgerJson(dir).requirement}`);
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 23a 打回批次上限：同一张卡前 2 批落进 bounces，第 3 批自动转 deferred（reason 含「超限」）
caseCheck('ledger-bounce-batch-cap', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: '打回上限', cards: [{ title: '目标卡' }, { title: '来源卡' }], gate: '' });
    if (init.status !== 0) return { ok: false, detail: `init 失败（${init.status}）：${init.stderr}` };
    const work = cardUpdate(dir, 1, { state: 'working' });
    if (work.status !== 0) return { ok: false, detail: `目标卡进入 working 失败（${work.status}）：${work.stderr}` };
    const bouncesOf = () => ledgerJson(dir).cards.find((c) => c.id === '1').bounces || [];
    const bounce = (text) =>
      ledger(['bounce', '1', '--stdin'], { project: dir, stdin: JSON.stringify({ text, source_card_id: '2' }) });

    for (let i = 1; i <= 2; i += 1) {
      const r = bounce(`第${i}批追加指令`);
      if (r.status !== 0) fails.push(`第 ${i} 批 bounce 应成功，实际退出码 ${r.status}：${r.stderr}`);
    }
    const beforeCap = ledgerJson(dir);
    if (bouncesOf().length !== 2) fails.push(`前 2 批应落在 bounces（长度 2），实际 ${JSON.stringify(bouncesOf())}`);
    if ((beforeCap.deferred || []).length !== 0) fails.push(`前 2 批不应产生 deferred，实际 ${JSON.stringify(beforeCap.deferred)}`);
    if (bouncesOf().some((b) => String(b.source_card_id) !== '2')) {
      fails.push(`bounces 未记录来源卡：${JSON.stringify(bouncesOf())}`);
    }

    const third = bounce('第3批追加指令');
    if (third.status !== 0) fails.push(`超限 bounce 应退出码 0（转 deferred），实际 ${third.status}：${third.stderr}`);
    const after = ledgerJson(dir);
    if (bouncesOf().length !== 2) fails.push(`第 3 批不应再进 bounces（应仍为 2），实际 ${bouncesOf().length}`);
    const deferred = after.deferred || [];
    if (deferred.length !== 1) fails.push(`第 3 批应转 deferred（1 条），实际 ${deferred.length}：${JSON.stringify(deferred)}`);
    else {
      const entry = deferred[0];
      if (entry.kind !== 'bounce') fails.push(`deferred kind 应为 bounce，实际 ${JSON.stringify(entry.kind)}`);
      if (String(entry.target_card_id) !== '1') fails.push(`deferred target_card_id 应为 1，实际 ${JSON.stringify(entry.target_card_id)}`);
      if (!String(entry.reason || '').includes('超限')) fails.push(`deferred reason 应含「超限」，实际 ${JSON.stringify(entry.reason)}`);
      if (entry.text !== '第3批追加指令') fails.push(`deferred text 不对：${JSON.stringify(entry.text)}`);
    }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 23b 迟到打回：目标卡已到终态（passed）后 bounce 不再进 bounces，直接转 deferred（reason 含「迟到」）
caseCheck('ledger-bounce-late-deferred', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: '迟到打回', cards: [{ title: '终态卡' }], gate: '' });
    if (init.status !== 0) return { ok: false, detail: `init 失败（${init.status}）：${init.stderr}` };
    for (const state of ['working', 'reviewing', 'passed']) {
      const r = cardUpdate(dir, 1, { state });
      if (r.status !== 0) return { ok: false, detail: `推进到 ${state} 失败（${r.status}）：${r.stderr}` };
    }
    const late = ledger(['bounce', '1', '--stdin'], { project: dir, stdin: JSON.stringify({ text: '迟到的追加指令', source_card_id: '1' }) });
    if (late.status !== 0) fails.push(`迟到 bounce 应退出码 0（转 deferred），实际 ${late.status}：${late.stderr}`);
    const l = ledgerJson(dir);
    const card = l.cards.find((c) => c.id === '1');
    if ((card.bounces || []).length !== 0) fails.push(`终态卡不应再收 bounces，实际 ${JSON.stringify(card.bounces)}`);
    if (card.state !== 'passed') fails.push(`迟到 bounce 不应改卡状态，实际 ${card.state}`);
    const deferred = l.deferred || [];
    if (deferred.length !== 1) fails.push(`迟到 bounce 应转 deferred（1 条），实际 ${deferred.length}：${JSON.stringify(deferred)}`);
    else {
      const entry = deferred[0];
      if (entry.kind !== 'bounce') fails.push(`deferred kind 应为 bounce，实际 ${JSON.stringify(entry.kind)}`);
      if (String(entry.target_card_id) !== '1') fails.push(`deferred target_card_id 应为 1，实际 ${JSON.stringify(entry.target_card_id)}`);
      if (!String(entry.reason || '').includes('迟到')) fails.push(`deferred reason 应含「迟到」，实际 ${JSON.stringify(entry.reason)}`);
      if (entry.text !== '迟到的追加指令') fails.push(`deferred text 不对：${JSON.stringify(entry.text)}`);
    }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 23c 按卡隔离：卡 A 用满 2 批后，卡 B 的第 1 批仍正常入 B.bounces，互不串账
caseCheck('ledger-bounce-per-card-isolation', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: '按卡隔离', cards: [{ title: '卡A' }, { title: '卡B' }], gate: '' });
    if (init.status !== 0) return { ok: false, detail: `init 失败（${init.status}）：${init.stderr}` };
    for (const id of [1, 2]) {
      const r = cardUpdate(dir, id, { state: 'working' });
      if (r.status !== 0) return { ok: false, detail: `卡 #${id} 进入 working 失败（${r.status}）：${r.stderr}` };
    }
    const bounce = (id, text) => ledger(['bounce', String(id), '--stdin'], { project: dir, stdin: JSON.stringify({ text }) });
    for (let i = 1; i <= 2; i += 1) {
      const r = bounce(1, `A-第${i}批`);
      if (r.status !== 0) fails.push(`卡 A 第 ${i} 批 bounce 应成功，实际 ${r.status}：${r.stderr}`);
    }
    const b = bounce(2, 'B-第1批');
    if (b.status !== 0) fails.push(`卡 A 用满后卡 B 第 1 批应成功，实际 ${b.status}：${b.stderr}`);
    const l = ledgerJson(dir);
    const a = l.cards.find((c) => c.id === '1');
    const bCard = l.cards.find((c) => c.id === '2');
    if ((a.bounces || []).length !== 2) fails.push(`卡 A bounces 应为 2，实际 ${(a.bounces || []).length}`);
    if ((bCard.bounces || []).length !== 1) fails.push(`卡 B bounces 应为 1，实际 ${(bCard.bounces || []).length}`);
    if ((bCard.bounces || [])[0] && bCard.bounces[0].text !== 'B-第1批') {
      fails.push(`卡 B 第 1 批内容不对：${JSON.stringify(bCard.bounces[0])}`);
    }
    if ((l.deferred || []).length !== 0) fails.push(`按卡隔离时不应产生 deferred，实际 ${JSON.stringify(l.deferred)}`);
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------ 宿主设置层回归（swarm-config.mjs） ------------------------------ */

/** 伪造 HOME 并写入宿主 plugins.options（~/.zcode/cli/config.json）。 */
function hostHome(options) {
  const dir = home(null);
  mkdirSync(join(dir, '.zcode', 'cli'), { recursive: true });
  writeFileSync(join(dir, '.zcode', 'cli', 'config.json'), JSON.stringify({ plugins: { options } }, null, 2), 'utf8');
  return dir;
}
const hostConfigOf = (h) => join(h, '.zcode', 'cli', 'config.json');

// 24 宿主层两种键格式（嵌套对象 / 扁平键）都生效，且 show 标注来源
caseCheck('host-nested-and-flat-keys', () => {
  // 宿主层现在只认返工轮数：嵌套对象与扁平键两种形态都要能读到。
  const homes = [
    hostHome({ 'zcode-swarm': { reworkRounds: 3 } }),
    hostHome({ 'zcode-swarm.reworkRounds': '3' }),
  ];
  const fails = [];
  try {
    const labels = ['嵌套对象', '扁平键'];
    homes.forEach((h, i) => {
      const text = cfg(['show'], { homeDir: h, cwd: h });
      if (text.status !== 0) fails.push(`${labels[i]} show 失败（${text.status}）：${text.stderr}`);
      if (!text.stdout.includes('返工轮数：3')) fails.push(`${labels[i]} show 未显示返工轮数 3`);
      if (!text.stdout.includes('宿主设置')) fails.push(`${labels[i]} show 未提示宿主层只读`);
      const json = cfg(['show', '--json'], { homeDir: h, cwd: h });
      let parsed = null;
      try { parsed = JSON.parse(json.stdout); } catch { /* fail below */ }
      if (!parsed) fails.push(`${labels[i]} show --json 不是合法 JSON`);
      else if (parsed.settings.rework_rounds !== 3) fails.push(`${labels[i]} 生效轮数应为 3，实际 ${parsed.settings.rework_rounds}`);
    });
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  }
});

// 25 项目作用域免疫：项目有自己的设置时，宿主层不再参与
caseCheck('host-project-scope-immunity', () => {
  const h = hostHome({ 'zcode-swarm': { reworkRounds: 4 } });
  const proj = join(h, 'proj');
  const roster = { rework_rounds: 2 };
  const fails = [];
  try {
    // 情形一：项目覆盖文件
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, '.swarm.json'), JSON.stringify(roster), 'utf8');
    const over = cfg(['show'], { homeDir: h, cwd: proj });
    if (over.status !== 0) fails.push(`override show 失败（${over.status}）：${over.stderr}`);
    if (!over.stdout.includes('返工轮数：2')) fails.push('override 作用域应使用项目自己的轮数 2（不叠加宿主 4）');
    if (!over.stdout.includes('项目覆盖')) fails.push('override show 未标注作用域');
    const overJson = cfg(['show', '--json'], { homeDir: h, cwd: proj });
    let overParsed = null;
    try { overParsed = JSON.parse(overJson.stdout); } catch { /* fail below */ }
    if (!overParsed || overParsed.scope.source !== 'override' || overParsed.settings.rework_rounds !== 2) {
      fails.push(`override show --json 不对：${overJson.stdout}`);
    }

    // 情形二：全局 settings.json 的 projects 条目
    rmSync(join(proj, '.swarm.json'), { force: true });
    const global = { version: 2, default: roster, projects: { [dirKey(proj)]: roster } };
    mkdirSync(join(h, '.zcode', 'zcode-swarm'), { recursive: true });
    writeFileSync(join(h, '.zcode', 'zcode-swarm', 'settings.json'), `${JSON.stringify(global, null, 2)}
`, 'utf8');
    const project = cfg(['show'], { homeDir: h, cwd: proj });
    if (project.status !== 0) fails.push(`projects 条目 show 失败（${project.status}）：${project.stderr}`);
    if (!project.stdout.includes('返工轮数：2')) fails.push('projects 条目作用域应使用自身轮数 2');
    if (!project.stdout.includes('本项目')) fails.push('projects 条目 show 未标注本项目作用域');
    const projJson = cfg(['show', '--json'], { homeDir: h, cwd: proj });
    let projParsed = null;
    try { projParsed = JSON.parse(projJson.stdout); } catch { /* fail below */ }
    if (!projParsed || projParsed.scope.source !== 'project' || projParsed.settings.rework_rounds !== 2) {
      fails.push(`projects 条目 show --json 不对：${projJson.stdout}`);
    }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

// 26 宿主层不物化：set 落盘不把宿主轮数写进项目条目，宿主 config.json 字节不变
caseCheck('host-no-materialize', () => {
  const h = hostHome({ 'zcode-swarm': { reworkRounds: 4 } });
  const fails = [];
  try {
    const hostBefore = readFileSync(hostConfigOf(h), 'utf8');
    const set = cfg(['set', '--stdin'], { homeDir: h, cwd: h, stdin: JSON.stringify({ rework_rounds: 1 }) });
    if (set.status !== 0) return { ok: false, detail: `set 失败（${set.status}）：${set.stderr}` };
    const settingsPath = join(h, '.zcode', 'zcode-swarm', 'settings.json');
    let disk = null;
    try { disk = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* fail below */ }
    if (!disk) return { ok: false, detail: '落盘 settings.json 不是合法 JSON' };
    const entry = disk.projects && disk.projects[dirKey(h)];
    if (!entry) fails.push('未物化出本项目条目');
    else if (entry.rework_rounds !== 1) fails.push(`轮数应为命令参数 1，实际 ${entry.rework_rounds}`);
    if (readFileSync(hostConfigOf(h), 'utf8') !== hostBefore) fails.push('宿主 config.json 被改动了');
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});


/* ------------------------------ 团队看板面板服务回归（swarm-board-server.mjs） ------------------------------ */

// SWARM_TEST_BOARD 仅供反向验证：把服务指向临时目录里的旧逻辑副本（默认恒指仓库当前服务）。
const BOARD_SERVER = process.env.SWARM_TEST_BOARD || join(REPO, 'scripts', 'swarm-board-server.mjs');
const PANEL_URI = 'ui://zcode-swarm/panel.html';
const BOARD_URI = 'ui://zcode-swarm/board.json';

/** 临时项目：写一份 ledger.json（传 null 表示不写台账）。 */
function boardProject(ledger) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-board-'));
  if (ledger !== null) {
    mkdirSync(join(dir, '.swarm'), { recursive: true });
    writeFileSync(join(dir, '.swarm', 'ledger.json'), typeof ledger === 'string' ? ledger : `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  }
  return dir;
}

const byId = (responses, id) => responses.find((r) => r.id === id);
const boardOf = (responses, id) => {
  const res = byId(responses, id);
  const c = res && res.result && res.result.contents && res.result.contents[0];
  if (!c || typeof c.text !== 'string') return null;
  try {
    return JSON.parse(c.text);
  } catch {
    return null;
  }
};

/** 等待 ms 毫秒（活体会话用例用；只用真实计时器，结束后自然排空）。 */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 异步用例执行壳：与 caseCheck 同口径，允许用例 await 推送观察。 */
async function caseCheckAsync(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = (await fn()) || {};
    ok = r.ok === true;
    detail = r.detail || '';
  } catch (err) {
    detail = `异常：${err && err.stack ? err.stack : err}`;
  }
  check(name, ok, detail);
}

/** updated 推送条数（可按 URI 过滤）。 */
const updatedCount = (messages, uri = BOARD_URI) =>
  messages.filter((m) => m && m.method === 'notifications/resources/updated' && (!uri || (m.params && m.params.uri === uri))).length;

/**
 * 活体服务会话：常驻 spawn 服务进程，按行收集 JSON-RPC 消息，便于观察推送。
 * 超时与清理对齐现有 spawnSync 用例：等待有上限，close 先关 stdin 再兜底 kill。
 */
function liveBoardServer(dir) {
  const child = spawn(process.execPath, [BOARD_SERVER], {
    cwd: dir,
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: dir, SWARM_PROJECT: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let stderr = '';
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = String(line).trim();
    if (!text) return;
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch {
      /* 非 JSON 行按原文记录，方便断言时看见 */
    }
    messages.push(msg ?? { raw: text });
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  // 子进程提前退出时 stdin 写入会异步报 EPIPE：必须挂监听，否则流 error 会把 runner 自己炸掉。
  child.stdin.on('error', () => {});
  child.on('error', () => {});
  const exited = new Promise((done) => child.once('exit', done));
  return {
    messages,
    stderr: () => stderr,
    send(message) {
      try {
        if (!child.stdin.destroyed) child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
      } catch {
        /* 进程已退出：后续断言会因缺响应而失败 */
      }
    },
    async waitFor(pred, { timeout = 3000, label = '条件' } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() <= deadline) {
        const hit = pred(messages);
        if (hit) return hit;
        await delay(40);
      }
      throw new Error(`等待${label}超时（${timeout}ms），已收 ${messages.length} 条消息`);
    },
    async close() {
      try {
        child.stdin.end();
      } catch {
        /* 已关闭 */
      }
      await Promise.race([exited, delay(1500)]);
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      await Promise.race([exited, delay(500)]);
    },
  };
}

// 27 握手：initialize / tools/list / resources/list 三项契约齐活
caseCheck('board-server-handshake', () => {
  const dir = boardProject({ run_id: 'run-test', status: 'running', cards: [{ id: '1', title: 'a', state: 'pending' }], gate: '' });
  try {
    // 用例是同步风格（caseCheck 只认同步返回），这里用 spawnSync + 管道输入跑一轮。
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    ].map((m) => JSON.stringify(m)).join('\n');
    const r = spawnSync(process.execPath, [BOARD_SERVER], {
      input: `${input}\n`,
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, ZCODE_WORKSPACE_ROOT: dir, SWARM_PROJECT: '' },
      timeout: 20000,
    });
    const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const init = byId(lines, 1);
    const tools = byId(lines, 2);
    const resources = byId(lines, 3);
    const fails = [];
    if (r.status !== 0) fails.push(`退出码 ${r.status}：${r.stderr || r.stdout}`);
    if (!init || !init.result) fails.push('initialize 没有响应');
    else {
      const caps = init.result.capabilities || {};
      if (!caps.tools) fails.push('initialize 应声明 tools 能力');
      if (!caps.resources || caps.resources.subscribe !== true) fails.push('initialize 应声明 resources.subscribe 能力');
      if (!init.result.serverInfo || !init.result.serverInfo.name) fails.push('initialize 缺少 serverInfo');
    }
    if (!tools || !tools.result || !Array.isArray(tools.result.tools)) fails.push('tools/list 结构不对');
    else if (!tools.result.tools.some((t) => t.name === 'swarm_board')) fails.push('tools/list 缺 swarm_board');
    if (!resources || !resources.result || !Array.isArray(resources.result.resources)) fails.push('resources/list 结构不对');
    else {
      const uris = resources.result.resources.map((x) => x.uri);
      for (const uri of [PANEL_URI, BOARD_URI]) if (!uris.includes(uri)) fails.push(`resources/list 缺 ${uri}`);
    }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 28 数据：board.json 的字段映射（中文状态/计数/截断），坏台账降级为 status:none
caseCheck('board-server-data', () => {
  const good = boardProject({
    run_id: 'run-data',
    status: 'running',
    requirement: '需求'.repeat(80),
    gate: 'npm test',
    gate_status: 'pass',
    gate_rounds: 2,
    created_at: '2026-11-16T00:00:00.000Z',
    updated_at: '2026-11-16T01:00:00.000Z',
    cards: [
      { id: '1', title: '通过卡', state: 'passed', model: 'm1', role: 'builder', result: { summary: '做完了' } },
      { id: '2', title: '施工卡', state: 'working', model: 'inherit' },
      { id: '3', title: '返工卡', state: 'rework', round: 2, error: '断言挂了' },
      { id: '4', title: '审查卡', state: 'reviewing' },
      { id: '5', title: '待开卡', state: 'pending' },
    ],
    findings: [{ text: 'f1' }, { text: 'f2' }],
    deferred: [],
    resolved_models: { light: 'inherit' },
  });
  const broken = boardProject('{ this is not json');
  const empty = boardProject(null);
  const dirs = [good, broken, empty];
  const fails = [];
  const req = (id, uri) => JSON.stringify({ jsonrpc: '2.0', id, method: 'resources/read', params: { uri } });
  const run = (dir, id) => spawnSync(process.execPath, [BOARD_SERVER], {
    input: `${req(id, BOARD_URI)}\n`,
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: dir, SWARM_PROJECT: '' },
    timeout: 20000,
  });
  try {
    const rGood = run(good, 1);
    if (rGood.status !== 0) return { ok: false, detail: `正常台账退出码 ${rGood.status}：${rGood.stderr}` };
    const data = boardOf(String(rGood.stdout || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)), 1);
    if (!data) return { ok: false, detail: `board.json 不是合法 JSON：${rGood.stdout}` };
    const labels = data.cards.map((c) => c.state_label);
    const expectLabels = ['已通过', '施工中', '返工中', '审查中', '待开工'];
    if (labels.join(',') !== expectLabels.join(',')) fails.push(`状态中文不对：${labels.join(',')}`);
    const counts = data.counts || {};
    for (const [k, v] of Object.entries({ passed: 1, working: 1, rework: 1, reviewing: 1, pending: 1, failed: 0 })) {
      if (counts[k] !== v) fails.push(`counts.${k} 应为 ${v}，实际 ${JSON.stringify(counts[k])}`);
    }
    if (!data.requirement || data.requirement.length > 121) fails.push(`requirement 应截断到 120 字，实际 ${data.requirement ? data.requirement.length : 'null'}`);
    if (!data.requirement.endsWith('…')) fails.push('超长 requirement 应以省略号结束');
    if (data.gate.status !== 'pass' || data.gate.rounds !== 2 || data.gate.command !== 'npm test') fails.push(`gate 映射不对：${JSON.stringify(data.gate)}`);
    if (data.findings_count !== 2) fails.push(`findings_count 应为 2，实际 ${data.findings_count}`);
    if (typeof data.elapsed_ms !== 'number' || data.elapsed_ms < 0) fails.push(`elapsed_ms 应为非负数，实际 ${JSON.stringify(data.elapsed_ms)}`);
    if (!data.cards[0].note || data.cards[0].note !== '做完了') fails.push(`passed 卡摘要取 result.summary，实际 ${JSON.stringify(data.cards[0].note)}`);
    if (data.cards[2].note !== '断言挂了') fails.push(`rework 卡摘要取 error，实际 ${JSON.stringify(data.cards[2].note)}`);
    if (data.cards[2].round !== 2) fails.push(`轮次映射不对：${JSON.stringify(data.cards[2].round)}`);
    // 卡片不再有 model 字段（档位已随插件模型配置一起移除）
    if ('model' in data.cards[1]) fails.push(`卡片不应再有 model 字段，实际 ${JSON.stringify(data.cards[1].model)}`);
    // 详情字段：面板要能回答「这张卡在做什么」
    if (typeof data.cards[0].task !== 'string') fails.push('卡片缺少 task 详情字段');
    if (!Array.isArray(data.cards[0].checks)) fails.push('卡片缺少 checks 详情字段');
    // 运行级：阶段与进度
    if (typeof data.phase !== 'string' || !data.phase) fails.push(`缺少 phase，实际 ${JSON.stringify(data.phase)}`);
    if (!data.progress || typeof data.progress.total !== 'number' || typeof data.progress.percent !== 'number') {
      fails.push(`progress 形状不对：${JSON.stringify(data.progress)}`);
    }

    for (const [dir, label] of [[broken, '坏 JSON'], [empty, '无台账']]) {
      const r = run(dir, 2);
      if (r.status !== 0) {
        fails.push(`${label}时服务不应崩溃（退出码 ${r.status}）：${r.stderr}`);
        continue;
      }
      const d = boardOf(String(r.stdout || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)), 2);
      if (!d || d.status !== 'none') fails.push(`${label}应返回 status:none，实际 ${JSON.stringify(d)}`);
      else if (!Array.isArray(d.cards) || d.cards.length !== 0) fails.push(`${label}的 cards 应为空数组`);
    }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});

// 29 面板：panel.html 以 text/html 返回；无头打开不报 JS 错、空态正常
caseCheck('board-server-panel', () => {
  const dir = boardProject(null);
  const fails = [];
  try {
    const r = spawnSync(process.execPath, [BOARD_SERVER], {
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: PANEL_URI } })}\n`,
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, ZCODE_WORKSPACE_ROOT: dir, SWARM_PROJECT: '' },
      timeout: 20000,
    });
    if (r.status !== 0) return { ok: false, detail: `退出码 ${r.status}：${r.stderr}` };
    const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const res = byId(lines, 1);
    const contents = res && res.result && res.result.contents;
    if (!Array.isArray(contents) || !contents[0]) return { ok: false, detail: `resources/read 面板返回结构不对：${r.stdout}` };
    const panel = contents[0];
    if (!String(panel.mimeType || '').startsWith('text/html')) fails.push(`面板 mimeType 应为 text/html，实际 ${JSON.stringify(panel.mimeType)}`);
    if (!String(panel.text || '').includes('团队看板')) fails.push('面板内容缺少「团队看板」标题');
    if (!String(panel.text || '').includes('本项目暂无运行中的团队')) fails.push('面板缺少空态文案');
    if (String(panel.text || '').includes('/*@@BOARD@@*/')) fails.push('面板里残留数据注入占位符');

    // 无头探针：把服务返回的面板原文写到临时文件，注入错误采集脚本后 dump DOM。
    // 断言不报 JS 错、空态与手动刷新按钮都在（宿主未连接时的第 3 级降级路径）。
    const chrome = [
      process.env.CHROME_PATH,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].filter(Boolean).find(existsSync);
    if (!chrome) {
      // 无浏览器不判失败（与 tc.mjs 的 SKIP 口径一致），只在 detail 里注明。
      return { ok: fails.length === 0, detail: `${fails.join('；')}${fails.length ? '；' : ''}无头校验跳过（找不到 Chrome/Edge）` };
    }
    const probeDir = mkdtempSync(join(tmpdir(), 'swarm-panel-probe-'));
    const probeFile = join(probeDir, 'panel.html');
    const inject =
      '<script>window.__errs=[];window.addEventListener("error",function(e){window.__errs.push("error: "+e.message)});' +
      'window.addEventListener("unhandledrejection",function(e){window.__errs.push("rejection: "+((e.reason&&e.reason.message)||e.reason))});</script>';
    const reporter =
      '<script>window.addEventListener("load",function(){setTimeout(function(){var p=document.createElement("pre");' +
      'p.id="probe";p.textContent="ERRS:"+window.__errs.join(" | ")+"\\nSTATE:"+' +
      'document.getElementById("sb-cards").textContent.replace(/\\s+/g," ").trim()+"\\nREFRESH:"+' +
      '(document.getElementById("sb-refresh").hidden?"hidden":"shown");document.body.appendChild(p);},1200)});</script>';
    const body = String(panel.text || '').replace('</head>', `${inject}</head>`).replace('</body>', `${reporter}</body>`);
    writeFileSync(probeFile, body, 'utf8');
    const dom = spawnSync(
      chrome,
      ['--headless=new', '--disable-gpu', '--virtual-time-budget=4000', '--dump-dom', `file:///${probeFile.replace(/\\/g, '/')}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90000 },
    );
    const probe = (/<pre id="probe">([\s\S]*?)<\/pre>/.exec(String(dom.stdout || '')) || [])[1];
    if (probe == null) fails.push(`无头探针没出结果（Chrome 退出码 ${dom.status}）`);
    else {
      const text = probe.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      if (!/^ERRS:\s*$/m.test(text.split('\n')[0] || '')) fails.push(`面板运行时报 JS 错：${text.split('\n')[0]}`);
      if (!text.includes('本项目暂无运行中的团队')) fails.push(`无头渲染缺空态文案：${text.slice(0, 200)}`);
      if (!text.includes('REFRESH:shown')) fails.push('静态降级时手动刷新按钮应为可见');
    }
    rmSync(probeDir, { recursive: true, force: true });
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 30 健壮性：未知方法回 JSON-RPC error，进程继续应答后续请求
caseCheck('board-server-robust', () => {
  const dir = boardProject({ run_id: 'run-robust', status: 'running', cards: [], gate: '' });
  try {
    const reqs = [
      { jsonrpc: '2.0', id: 1, method: 'does/not/exist' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ui://zcode-swarm/nope' } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'swarm_board', arguments: {} } },
    ];
    const r = spawnSync(process.execPath, [BOARD_SERVER], {
      input: `${reqs.map((x) => JSON.stringify(x)).join('\n')}\n`,
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, ZCODE_WORKSPACE_ROOT: dir, SWARM_PROJECT: '' },
      timeout: 20000,
    });
    if (r.status !== 0) return { ok: false, detail: `退出码 ${r.status}：${r.stderr}` };
    const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const fails = [];
    const unknown = byId(lines, 1);
    if (!unknown || !unknown.error || !Number.isInteger(unknown.error.code)) fails.push(`未知方法应返回 JSON-RPC error，实际 ${JSON.stringify(unknown)}`);
    const ping = byId(lines, 2);
    if (!ping || !ping.result) fails.push('未知方法之后进程应继续应答 ping');
    const badUri = byId(lines, 3);
    if (!badUri || !badUri.error) fails.push('未知资源应返回 JSON-RPC error');
    const badTool = byId(lines, 4);
    if (!badTool || !badTool.error) fails.push('未知工具应返回 JSON-RPC error');
    const call = byId(lines, 5);
    if (!call || !call.result) fails.push('错误请求之后 swarm_board 仍应成功');
    else {
      const structured = call.result.structuredContent;
      if (!structured || structured.status !== 'running') fails.push(`swarm_board 应返回结构化概要，实际 ${JSON.stringify(structured && structured.status)}`);
      // 0.4.3 起工具只返回运行概要（不含 cards），完整数据走 resources/read
      if (structured && structured.cards !== undefined) fails.push('swarm_board 概要不应再含 cards（双看板修复）');
      if (structured && (structured.progress === undefined || structured.counts === undefined)) fails.push('swarm_board 概要应含 progress/counts');
      const text = (call.result.content && call.result.content[0] && call.result.content[0].text) || '';
      if (!text.includes('resources/read')) fails.push('swarm_board 文本应指引 resources/read 取完整数据');
    }
    if (lines.length !== reqs.length) fails.push(`应回 ${reqs.length} 条响应，实际 ${lines.length} 条`);
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------ 探针固化回归（卡 1 已验证判别力，扩编为正式用例） ------------------------------ */

/** 带 await 的活体会话用例：下面六条推送/协议类断言需要跨进程观察 stdout 流，故不共用同步壳。 */
const liveCase = (name, fn) => caseCheckAsync(name, fn);

/** 静默服务会话：按需注入 stdin 行，收集全部响应（同步 spawnSync 风格不变，仅用于无推送场景）。 */
function boardOnce(dir, lines) {
  return spawnSync(process.execPath, [BOARD_SERVER], {
    input: `${lines.join('\n')}\n`,
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: dir, SWARM_PROJECT: '' },
    timeout: 20000,
  });
}

/** 解析一行一条的 JSON-RPC stdout；坏行返回 null 便于用例报清楚。 */
function parseNdjson(stdout) {
  try {
    return String(stdout || '')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}

/** 覆盖式写台账（模拟真实写入方：整份重写，不保留临时文件）。 */
const writeLedger = (dir, ledger) =>
  writeFileSync(join(dir, '.swarm', 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');

// 31 推送去抖与同内容重写不推送：同内容重写 updated 新增 0 条；真实变更 1 条
await liveCase('board-server-notify-debounce', async () => {
  const base = {
    run_id: 'run-notify',
    status: 'running',
    requirement: '去抖探针',
    gate: 'npm test',
    created_at: '2026-11-16T00:00:00.000Z',
    updated_at: '2026-11-16T00:00:00.000Z',
    cards: [{ id: '1', title: '卡一', state: 'pending' }],
  };
  const dir = boardProject(base);
  const session = liveBoardServer(dir);
  const fails = [];
  try {
    session.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
    session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    session.send({ jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri: BOARD_URI } });
    session.send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: BOARD_URI } });
    await session.waitFor((m) => m.some((x) => x && x.id === 3), { label: '首读响应' });
    // 基线：首读已记指纹，等去抖窗口排空
    await delay(400);
    const before = updatedCount(session.messages);

    // 同内容重写三次（真实写入方整份重写台账，内容与指纹一致）
    for (let i = 0; i < 3; i += 1) {
      writeLedger(dir, base);
      await delay(250);
    }
    await delay(400);
    const afterSame = updatedCount(session.messages);
    if (afterSame !== before) fails.push(`同内容重写不应推送，实际新增 ${afterSame - before} 条`);

    // 真实变更：新增一张卡
    writeLedger(dir, { ...base, updated_at: '2026-11-16T00:01:00.000Z', cards: [...base.cards, { id: '2', title: '卡二', state: 'working' }] });
    let sawPush = false;
    try {
      await session.waitFor((m) => updatedCount(m) > afterSame, { timeout: 3000, label: '真实变更推送' });
      sawPush = true;
    } catch (err) {
      fails.push(`真实变更后未收到推送：${err.message}；stderr=${session.stderr()}`);
    }
    const afterReal = updatedCount(session.messages);
    if (sawPush && afterReal - afterSame !== 1) fails.push(`真实变更应推 1 条，实际 ${afterReal - afterSame} 条`);
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    if (session) await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// 32 首屏占位符注入安全：requirement 含 /*@@END@@*/ 时 EMBEDDED 仍是合法 JSON 且 requirement 原样
caseCheck('board-server-panel-placeholder-safety', () => {
  const requirement = '需求含占位符 /*@@END@@*/ 与 BOARD /*@@BOARD@@*/ 都不该丢';
  const dir = boardProject({ run_id: 'run-inject', status: 'running', requirement, gate: '', cards: [{ id: '1', title: 'a', state: 'pending' }] });
  const fails = [];
  try {
    const r = boardOnce(dir, [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: PANEL_URI } })]);
    if (r.status !== 0) return { ok: false, detail: `退出码 ${r.status}：${r.stderr}` };
    const lines = parseNdjson(r.stdout);
    if (!lines) return { ok: false, detail: `stdout 不是逐行 JSON：${r.stdout}` };
    const panel = (byId(lines, 1) || {}).result?.contents?.[0]?.text || '';
    if (!panel) return { ok: false, detail: '面板返回为空' };
    // 取注入段：`var EMBEDDED = ` 之后到语句结束的 `;` 前（服务已知会转义 <，不含脚本闭合）
    const m = /var EMBEDDED = ([\s\S]*?);\s*\n/.exec(panel);
    if (!m) return { ok: false, detail: '面板里找不到 EMBEDDED 注入段' };
    let embedded = null;
    try {
      // 服务已把 < 与 U+2028/29 转义成 \uXXXX，JSON.parse 直接可用
      embedded = JSON.parse(m[1]);
    } catch (err) {
      return { ok: false, detail: `EMBEDDED 不是合法 JSON：${err.message}；片段 ${m[1].slice(0, 160)}` };
    }
    if (!embedded || typeof embedded !== 'object') fails.push(`EMBEDDED 应为对象，实际 ${JSON.stringify(embedded)}`);
    else if (embedded.requirement !== requirement) fails.push(`requirement 被占位符清理抹坏：${JSON.stringify(embedded.requirement)}`);
    // 注入段之外的模板壳里不应残留任何数据占位符（数据本身允许含有同名字样）
    const shell = `${panel.slice(0, m.index)}${panel.slice(m.index + m[0].length)}`;
    if (shell.includes('/*@@BOARD@@*/') || shell.includes('/*@@END@@*/')) fails.push('面板模板壳里残留未清理的数据占位符');
    if (panel.includes('\u0000@@SWARM_BOARD_DATA@@\u0000')) fails.push('面板里残留数据槽位');
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 33 BOM 台账：UTF-8 BOM 前缀的 ledger.json 仍读出 status=running
caseCheck('board-server-bom-ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-board-'));
  const fails = [];
  try {
    mkdirSync(join(dir, '.swarm'), { recursive: true });
    const ledger = { run_id: 'run-bom', status: 'running', requirement: '记事本保存的台账', gate: '', cards: [] };
    // 带 BOM 落盘（Windows 记事本 UTF-8 的典型产物）
    writeFileSync(join(dir, '.swarm', 'ledger.json'), `\ufeff${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    const r = boardOnce(dir, [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: BOARD_URI } })]);
    if (r.status !== 0) return { ok: false, detail: `退出码 ${r.status}：${r.stderr}` };
    const lines = parseNdjson(r.stdout);
    if (!lines) return { ok: false, detail: `stdout 不是逐行 JSON：${r.stdout}` };
    const data = boardOf(lines, 1);
    if (!data) return { ok: false, detail: `board.json 不是合法 JSON：${r.stdout}` };
    if (data.status !== 'running') fails.push(`BOM 台账应读出 status=running，实际 ${JSON.stringify(data.status)}`);
    if (data.status_label !== '运行中') fails.push(`status_label 应为运行中，实际 ${JSON.stringify(data.status_label)}`);
    if (data.requirement !== ledger.requirement) fails.push(`requirement 未读出：${JSON.stringify(data.requirement)}`);
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 34 原型链污染防护：cards[].state 为 __proto__/constructor 时 counts 只含 6 个合法键、state_label 为待开工
caseCheck('board-server-proto-state', () => {
  const dir = boardProject({
    run_id: 'run-proto',
    status: 'running',
    requirement: '原型链状态',
    gate: '',
    cards: [
      { id: '1', title: 'proto', state: '__proto__' },
      { id: '2', title: 'ctor', state: 'constructor' },
      { id: '3', title: 'toString', state: 'toString' },
      { id: '4', title: '真状态', state: 'working' },
    ],
  });
  const fails = [];
  try {
    const r = boardOnce(dir, [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: BOARD_URI } })]);
    if (r.status !== 0) return { ok: false, detail: `退出码 ${r.status}：${r.stderr}` };
    const lines = parseNdjson(r.stdout);
    if (!lines) return { ok: false, detail: `stdout 不是逐行 JSON：${r.stdout}` };
    const data = boardOf(lines, 1);
    if (!data) return { ok: false, detail: `board.json 不是合法 JSON：${r.stdout}` };
    const legal = ['passed', 'failed', 'working', 'reviewing', 'rework', 'pending'];
    const keys = Object.keys(data.counts || {}).sort();
    if (keys.join(',') !== [...legal].sort().join(',')) fails.push(`counts 只应含 6 个合法键，实际 ${keys.join(',')}`);
    const protoCards = (data.cards || []).filter((c) => c.id === '1' || c.id === '2' || c.id === '3');
    if (protoCards.length !== 3) fails.push(`原型链状态卡应映射 3 张，实际 ${protoCards.length}`);
    for (const c of protoCards) {
      if (c.state !== 'pending') fails.push(`卡 ${c.id} 的 state 应降级为 pending，实际 ${JSON.stringify(c.state)}`);
      if (c.state_label !== '待开工') fails.push(`卡 ${c.id} 的 state_label 应为待开工，实际 ${JSON.stringify(c.state_label)}`);
    }
    const work = (data.cards || []).find((c) => c.id === '4');
    if (!work || work.state !== 'working' || work.state_label !== '施工中') fails.push(`正常状态卡映射不对：${JSON.stringify(work)}`);
    if (data.counts && data.counts.pending !== 3) fails.push(`pending 计数应为 3，实际 ${JSON.stringify(data.counts && data.counts.pending)}`);
    if (data.counts && data.counts.working !== 1) fails.push(`working 计数应为 1，实际 ${JSON.stringify(data.counts && data.counts.working)}`);
    // 污染测试：JSON.parse 出来的 __proto__ 键若被合并进新对象会带出额外键；counts 干净即证明没被污染
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 35 tools/call 后 updated 推送不被吞：真变更 + tools/call 后面板仍收到推送
await liveCase('board-server-tools-call-keeps-notify', async () => {
  const base = {
    run_id: 'run-call',
    status: 'running',
    requirement: '工具调用后仍推',
    gate: '',
    // 刻意不写 created_at：elapsed_ms 恒为 0，指纹里没有逐秒漂移的字段。
    // 这样“tools/call 记指纹”的旧实现才会在去抖到点时判等、吞掉该发的推送（判别力所在）。
    cards: [{ id: '1', title: '卡一', state: 'pending' }],
  };
  const dir = boardProject(base);
  const fails = [];
  let session = null;
  try {
    session = liveBoardServer(dir);
    session.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
    session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    session.send({ jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri: BOARD_URI } });
    session.send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: BOARD_URI } });
    await session.waitFor((m) => m.some((x) => x && x.id === 3), { label: '首读响应' });
    await delay(400);
    const baseline = updatedCount(session.messages);

    // 关键时序：写完台账立即 tools/call，让工具调用落在 150ms 去抖窗口内。
    // 旧实现会在 tools/call 里记指纹，去抖到点后比对“无变化”，把这条该发的推送吞掉。
    writeLedger(dir, { ...base, updated_at: '2026-11-16T00:01:00.000Z', cards: [...base.cards, { id: '2', title: '卡二', state: 'working' }] });
    session.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'swarm_board', arguments: {} } });
    await session.waitFor((m) => m.some((x) => x && x.id === 4), { label: 'tools/call 响应' });
    const call = byId(session.messages, 4);
    if (!call || !call.result) fails.push('tools/call 应成功');
    else if (!call.result.structuredContent || call.result.structuredContent.progress === undefined || call.result.structuredContent.progress.total !== 2) fails.push(`tools/call 概要应含 progress.total=2，实际 ${JSON.stringify(call.result.structuredContent && call.result.structuredContent.progress)}`);

    try {
      await session.waitFor((m) => updatedCount(m) > baseline, { timeout: 3000, label: 'tools/call 后推送' });
    } catch (err) {
      fails.push(`tools/call 之后 updated 推送被吞：${err.message}；stderr=${session.stderr()}`);
    }
    const after = updatedCount(session.messages);
    if (after - baseline !== 1) fails.push(`tools/call 后应收到 1 条推送，实际 ${after - baseline} 条`);
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    if (session) await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// 36 非对象消息（null/42 行）回 -32600 且后续 ping 仍应答，无 TypeError
caseCheck('board-server-non-object-message', () => {
  const dir = boardProject({ run_id: 'run-nonobj', status: 'running', cards: [], gate: '' });
  const fails = [];
  try {
    // 前两行是原始 JSON 文本（不是 JSON.stringify 的对象）：null 与标量 42
    const r = boardOnce(dir, [
      'null',
      '42',
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    ]);
    if (r.status !== 0) return { ok: false, detail: `退出码 ${r.status}：${r.stderr}` };
    if (/TypeError/.test(String(r.stderr || ''))) fails.push(`stderr 出现 TypeError：${r.stderr}`);
    const lines = parseNdjson(r.stdout);
    if (!lines) return { ok: false, detail: `stdout 不是逐行 JSON：${r.stdout}` };
    if (lines.length !== 3) fails.push(`应回 3 条响应，实际 ${lines.length} 条：${r.stdout}`);
    const nullRes = lines.find((x) => x && x.error && x.error.code === -32600 && x.id === null);
    if (!nullRes) fails.push(`null 行应回 id=null 的 -32600，实际 ${JSON.stringify(lines[0])}`);
    const scalarRes = lines.filter((x) => x && x.error && x.error.code === -32600);
    if (scalarRes.length !== 2) fails.push(`null 与 42 各应回 -32600，实际 ${scalarRes.length} 条`);
    const ping = byId(lines, 3);
    if (!ping || !ping.result) fails.push(`非对象消息之后 ping 应应答，实际 ${JSON.stringify(ping)}`);
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------ 部署产物新鲜度回归（ensure 修复点） ------------------------------ */

/** 读仓库模板，把模型块换成明显过期的戳与旧模型，模拟部署遗留、正文没跟上的旧 saved 工作流。 */
function staleWorkflowText() {
  const template = readFileSync(join(REPO, 'workflows', 'zcode-swarm.dwf.ts'), 'utf8');
  return template
    .replace(/^\/\/ @@SWARM_MODELS_BEGIN.*$/m, '// @@SWARM_MODELS_BEGIN template=000000000000 settings=000000000000（由 swarm-config.mjs 生成）')
    .replace(/^  light: undefined,$/m, '  light: model("magpie/legacy/old-model"),');
}
const wfNameOf = (key) => `zcode-swarm-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`;

// 37 项目作用域兜底刷新：projects 条目让作用域是 project 时，ensure 仍要按全局 default 刷新兜底工作流
caseCheck('ensure-refreshes-fallback-in-project-scope', () => {
  const defaultRoster = { models: { light: 'inherit', strong: 'inherit', hard: 'inherit' }, review_model: 'strong', rework_rounds: 2 };
  const h = home(`${JSON.stringify({ version: 2, default: defaultRoster, projects: {} }, null, 2)}\n`);
  // 参考 HOME（全新、default 作用域）：同一份 default 名单新渲染出的兜底工作流就是期望全文
  const ref = home(null);
  const proj = join(h, 'proj');
  mkdirSync(proj, { recursive: true });
  const key = dirKey(proj);
  const wfDir = join(h, '.zcode', 'workflows');
  const fallback = join(wfDir, 'zcode-swarm.dwf.ts');
  const fails = [];
  try {
    // 让当前作用域变成 project：projects 里给本项目一份专属名单
    const global = {
      version: 2,
      default: defaultRoster,
      projects: { [key]: { models: { light: 'magpie/kimi-code-cn/k3.1-pro', strong: 'inherit', hard: 'inherit' }, review_model: 'strong', rework_rounds: 2 } },
    };
    writeFileSync(join(h, '.zcode', 'zcode-swarm', 'settings.json'), `${JSON.stringify(global, null, 2)}\n`, 'utf8');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(fallback, staleWorkflowText(), 'utf8');
    const refEnsure = cfg(['ensure', '--quiet'], { homeDir: ref, cwd: ref });
    if (refEnsure.status !== 0) return { ok: false, detail: `参考 HOME ensure 失败（${refEnsure.status}）：${refEnsure.stderr}` };
    const refFile = join(ref, '.zcode', 'workflows', 'zcode-swarm.dwf.ts');
    if (!existsSync(refFile)) return { ok: false, detail: '参考 HOME 未生成兜底工作流，无法比对' };
    const expected = readFileSync(refFile, 'utf8');
    if (readFileSync(fallback, 'utf8') === expected) return { ok: false, detail: '前置失败：伪造的兜底工作流已是新鲜全文，用例无效' };
    const run = cfg(['ensure'], { homeDir: h, cwd: proj });
    if (run.status !== 0) fails.push(`ensure 失败（${run.status}）：${run.stderr}`);
    if (readFileSync(fallback, 'utf8') !== expected) fails.push('project 作用域下 ensure 没有刷新兜底工作流（应重写为按全局 default 渲染的全文）');
    const scope = cfg(['show', '--json'], { homeDir: h, cwd: proj });
    let parsed = null;
    try {
      parsed = JSON.parse(scope.stdout);
    } catch {
      /* fail below */
    }
    if (!parsed || parsed.scope.source !== 'project') fails.push(`前置失败：作用域不是 project（${scope.stdout}）`);
    if (!existsSync(join(wfDir, `${wfNameOf(key)}.dwf.ts`))) fails.push('ensure 未生成当前项目的工作流');
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(h, { recursive: true, force: true });
    rmSync(ref, { recursive: true, force: true });
  }
});

// 38 正文漂移：戳行正确但正文被截断时 ensure 必须判过期并重写全文
caseCheck('ensure-rewrites-drifted-body', () => {
  const roster = { models: { light: 'inherit', strong: 'inherit', hard: 'inherit' }, review_model: 'strong', rework_rounds: 2 };
  const h = home(`${JSON.stringify({ version: 2, default: roster, projects: {} }, null, 2)}\n`);
  const fails = [];
  try {
    const key = dirKey(h);
    const target = join(h, '.zcode', 'workflows', `${wfNameOf(key)}.dwf.ts`);
    const first = cfg(['render', '--quiet'], { homeDir: h, cwd: h });
    if (first.status !== 0) return { ok: false, detail: `render 失败（${first.status}）：${first.stderr}` };
    if (!existsSync(target)) return { ok: false, detail: `render 未生成项目工作流 ${target}` };
    const original = readFileSync(target, 'utf8');
    const end = original.indexOf('@@SWARM_MODELS_END');
    if (end < 0) return { ok: false, detail: '渲染结果缺少模型块结束戳' };
    // 戳行保留、正文砍在半途（部署中断/被外部覆盖的典型残留）
    writeFileSync(target, original.slice(0, end + '@@SWARM_MODELS_END'.length), 'utf8');
    const run = cfg(['ensure'], { homeDir: h, cwd: h });
    if (run.status !== 0) fails.push(`ensure 失败（${run.status}）：${run.stderr}`);
    if (!run.stderr.includes('正文有漂移')) fails.push(`ensure 未报「正文有漂移」：${run.stderr}`);
    if (readFileSync(target, 'utf8') !== original) fails.push('正文漂移未被重写为完整全文');
    const again = cfg(['ensure'], { homeDir: h, cwd: h });
    if (again.status !== 0 || !again.stderr.includes('已是最新')) fails.push(`修复后再次 ensure 应判定最新：${again.stderr}`);
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

/* ------------------------------ hooks 静态 lint（Windows cmd.exe 可移植性） ------------------------------ */

// 39 hooks 命令可移植性：不得含 POSIX 重定向字面量，且每个 command 钩子必须带 onError:"allow"
caseCheck('hooks-portable-commands', () => {
  const hooksPath = join(REPO, 'hooks', 'hooks.json');
  if (!existsSync(hooksPath)) return { ok: false, detail: `找不到 ${hooksPath}` };
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(hooksPath, 'utf8'));
  } catch (error) {
    return { ok: false, detail: `hooks.json 不是合法 JSON：${error.message}` };
  }
  const hooks = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (typeof node.command === 'string') hooks.push(node);
    for (const value of Object.values(node)) walk(value);
  };
  walk(doc);
  if (hooks.length === 0) return { ok: false, detail: 'hooks.json 里没有可检查的 command 钩子（结构可能变了）' };
  const forbidden = ['2>/dev/null', '1>/dev/null', '&>/dev/null', '>/dev/null', '||'];
  const fails = [];
  hooks.forEach((hook, index) => {
    const cmd = hook.command;
    if (hook.onError !== 'allow') fails.push(`第 ${index + 1} 个钩子缺少 onError:"allow"：${cmd}`);
    for (const token of forbidden) {
      if (cmd.includes(token)) fails.push(`第 ${index + 1} 个钩子含 POSIX 重定向「${token}」（cmd.exe 下解析不了）：${cmd}`);
    }
  });
  return { ok: fails.length === 0, detail: fails.join('；') };
});

// 38 宿主 per-agent 覆盖提示：agents-state.json 里给了角色模型，show 必须列出它并说明优先级高于名单
caseCheck('show-reports-host-agent-overrides', () => {
  const roster = { models: { light: 'inherit', strong: 'inherit', hard: 'inherit' }, review_model: 'strong', rework_rounds: 2 };
  const h = home(`${JSON.stringify({ version: 2, default: roster, projects: {} }, null, 2)}\n`);
  const agentState = {
    pluginAgentModelSelectionOverrides: {
      'plugin:zcode-swarm@zcode-swarm-market:swarm-builder': {
        providerId: 'magpie',
        modelId: 'opendesign/deepseek-v4.1-flash-eco',
        options: { reasoningLevel: 'max' },
      },
    },
  };
  const v2dir = join(h, '.zcode', 'v2');
  mkdirSync(v2dir, { recursive: true });
  writeFileSync(join(v2dir, 'agents-state.json'), `${JSON.stringify(agentState, null, 2)}\n`, 'utf8');
  const fails = [];
  let clean = null;
  try {
    // 文本模式：被覆盖的角色与模型出现在提示里，且点明优先级高于名单
    const text = cfg(['show'], { homeDir: h, cwd: h });
    if (text.status !== 0) return { ok: false, detail: `show 失败（${text.status}）：${text.stderr}` };
    if (!text.stdout.includes('团队角色模型')) fails.push('show 文本没有角色模型区块');
    if (!text.stdout.includes('magpie/opendesign/deepseek-v4.1-flash-eco$max')) fails.push('show 文本没有列出 builder 的实际覆盖模型');
    if (!text.stdout.includes('← 宿主设置')) fails.push('show 文本没有标注 builder 的来源为宿主设置');
    // JSON 模式：结构化暴露，便于主会话读取
    const json = cfg(['show', '--json'], { homeDir: h, cwd: h });
    if (json.status !== 0) return { ok: false, detail: `show --json 失败（${json.status}）：${json.stderr}` };
    let doc = null;
    try {
      doc = JSON.parse(json.stdout);
    } catch (error) {
      return { ok: false, detail: `show --json 不是合法 JSON：${error.message}` };
    }
    const roles = Array.isArray(doc.roles) ? doc.roles.filter((item) => item.source === '宿主设置') : [];
    if (roles.length !== 1) fails.push(`agentOverrides.roles 应有 1 项，实际 ${roles.length} 项`);
    else if (roles[0].role !== 'builder' || !String(roles[0].model).includes('deepseek-v4.1-flash-eco')) {
      fails.push(`roles 角色/模型不对：${JSON.stringify(roles[0])}`);
    }
    // 没有 agents-state 的干净 HOME：不应出现该提示（避免误报）
    clean = home(null);
    const cleanShow = cfg(['show'], { homeDir: clean, cwd: clean });
    if (cleanShow.status === 0 && cleanShow.stdout.includes('← 宿主设置')) {
      fails.push('干净 HOME 下 show 不该出现宿主设置来源');
    }
  } finally {
    rmSync(h, { recursive: true, force: true });
    if (clean) rmSync(clean, { recursive: true, force: true });
  }
  return { ok: fails.length === 0, detail: fails.join('；') };
});

// 38 旧设置文件自动规范化：含废弃 models/review_model 时，读取即按新 schema 写回磁盘
caseCheck('legacy-model-fields-normalized-on-read', () => {
  const legacy = {
    version: 2,
    default: { models: { light: 'magpie/zcode/GLM-5.3$high', strong: 'inherit', hard: 'inherit' }, review_model: 'strong', rework_rounds: 2 },
    projects: {},
  };
  const h = home(`${JSON.stringify(legacy, null, 2)}
`);
  const settingsPath = join(h, '.zcode', 'zcode-swarm', 'settings.json');
  const fails = [];
  try {
    const r = cfg(['show', '--json'], { homeDir: h, cwd: h });
    if (r.status !== 0) return { ok: false, detail: `show 失败（${r.status}）：${r.stderr}` };
    let disk = null;
    try { disk = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* fail below */ }
    if (!disk) fails.push('设置文件读不回来');
    else {
      if (disk.default.models !== undefined) fails.push('磁盘 default 仍含废弃的 models 字段');
      if (disk.default.review_model !== undefined) fails.push('磁盘 default 仍含废弃的 review_model 字段');
      if (disk.default.rework_rounds !== 2) fails.push(`rework_rounds 应保留为 2，实际 ${disk.default.rework_rounds}`);
    }
    // 幂等：第二次读取不该再产生写回提示
    const again = cfg(['show', '--json'], { homeDir: h, cwd: h });
    if (again.status !== 0) fails.push(`二次 show 失败（${again.status}）`);
    else if (again.stderr.includes('已按新 schema')) fails.push('二次读取仍在写回（说明规范化不幂等）');
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

/* ------------------------------ 端到端全链（/swarm 真实命令序列） ------------------------------ */

// 41 端到端全链：show → validate → init → 状态机（含两步返工）→ bounce 上限 → finding → spawn →
// gate → fixer → finish → report → render board/report。全部用真实脚本在系统临时目录里跑，串起一条完整运行；
// 任一环节断裂即 FAIL。每个命令都断言「退出码 + 输出内容」，不是只看退出码。
caseCheck('e2e-full-cycle', () => {
  const homeDir = home(null);
  const project = tmpProject();
  const uiRoot = tmpProject();
  const fails = [];
  const say = (cond, msg) => {
    if (!cond) fails.push(msg);
  };

  // 本次运行的角色模型（builder 用可辨识的值，后面 report 要原样出现）。
  const BUILDER_MODEL = 'magpie/opendesign/deepseek-v4.1-flash-eco$max';
  const RESOLVED = [
    { role: 'planner', model: 'inherit', source: '继承默认' },
    { role: 'architect', model: 'inherit', source: '继承默认' },
    { role: 'builder', model: BUILDER_MODEL, source: '宿主设置' },
    { role: 'reviewer', model: 'inherit', source: '继承默认' },
    { role: 'fixer', model: 'inherit', source: '继承默认' },
  ];
  const CARDS = [
    { id: '1', title: '端到端甲', task: '做甲', scope: 'src/a/', acceptance: '甲通过', role: 'builder' },
    { id: '2', title: '端到端乙', task: '做乙', scope: 'src/b/', acceptance: '乙通过', role: 'reviewer' },
  ];
  const cardOf = (id) => (ledgerJson(project).cards || []).find((c) => String(c.id) === String(id)) || {};
  const expectStep = (id, state, round, label) => {
    const card = cardOf(id);
    say(card.state === state, `${label}：台账 state 应为 ${state}，实际 ${JSON.stringify(card.state)}`);
    say(card.round === round, `${label}：台账 round 应为 ${round}，实际 ${JSON.stringify(card.round)}`);
  };
  try {
    // ── 1. show --json：5 个角色（role/model/source）+ 返工轮数 ──
    const shown = cfg(['show', '--json'], { homeDir });
    let showDoc = null;
    try { showDoc = JSON.parse(shown.stdout); } catch { /* 下面的断言会失败 */ }
    const roles = showDoc && Array.isArray(showDoc.roles) ? showDoc.roles : [];
    say(shown.status === 0, `show --json 退出码 ${shown.status}：${shown.stderr}`);
    say(roles.length === 5, `show --json roles 应为 5 项，实际 ${roles.length}：${shown.stdout}`);
    const roleNames = roles.map((item) => item.role).join(',');
    say(
      ['planner', 'architect', 'builder', 'reviewer', 'fixer'].every((role) => roles.some((item) => item.role === role)),
      `show --json 角色不全：${roleNames}`,
    );
    say(
      roles.every((item) => typeof item.role === 'string' && typeof item.model === 'string' && typeof item.source === 'string'),
      `show --json 角色项缺少 role/model/source：${JSON.stringify(roles)}`,
    );
    say(
      showDoc && showDoc.settings && typeof showDoc.settings.rework_rounds === 'number',
      `show --json 缺 settings.rework_rounds：${shown.stdout}`,
    );

    // ── 2. validate --stdin：2 张不重叠卡通过，输出 { cards, workflow }，无 resolved/healed ──
    const validated = cfg(['validate', '--stdin'], { homeDir, stdin: JSON.stringify({ cards: CARDS }) });
    let validateDoc = null;
    try { validateDoc = JSON.parse(validated.stdout); } catch { /* 下面的断言会失败 */ }
    say(validated.status === 0, `validate 退出码 ${validated.status}：${validated.stderr}`);
    say(validated.stderr.includes('校验通过'), `validate 未提示校验通过：${validated.stderr}`);
    say(
      validateDoc && Array.isArray(validateDoc.cards) && validateDoc.cards.length === 2,
      `validate 输出 cards 应为 2 项：${validated.stdout}`,
    );
    say(
      validateDoc && typeof validateDoc.workflow === 'string' && validateDoc.workflow.trim() !== '',
      `validate 输出缺 workflow：${validated.stdout}`,
    );
    say(
      validateDoc && validateDoc.resolved === undefined && validateDoc.healed === undefined,
      `validate 不应再输出 resolved/healed：${validated.stdout}`,
    );

    // ── 3. init --stdin：带 agent_models + rework_rounds，台账落盘、run-*、卡片 pending ──
    const init = ledgerInit(project, {
      requirement: '端到端全链回归',
      cards: CARDS,
      gate: 'node --version',
      agent_models: { resolved: RESOLVED },
      rework_rounds: 1,
    });
    say(init.status === 0, `init 退出码 ${init.status}：${init.stderr}`);
    say(init.stdout.includes('已初始化台账'), `init 未提示已初始化台账：${init.stdout}`);
    say(existsSync(ledgerPathOf(project)), `台账文件未生成：${ledgerPathOf(project)}`);
    if (existsSync(ledgerPathOf(project))) {
      const l0 = ledgerJson(project);
      say(/^run-/.test(String(l0.run_id)), `run_id 应形如 run-*，实际 ${JSON.stringify(l0.run_id)}`);
      say(
        Array.isArray(l0.cards) && l0.cards.length === 2 && l0.cards.every((c) => c.state === 'pending'),
        `init 后两张卡都应为 pending：${JSON.stringify((l0.cards || []).map((c) => c.state))}`,
      );
      say(l0.rework_rounds === 1, `init 的 rework_rounds 应落账为 1，实际 ${JSON.stringify(l0.rework_rounds)}`);
      say(
        l0.agent_models && Array.isArray(l0.agent_models.resolved) && l0.agent_models.resolved.length === 5,
        `init 的 agent_models.resolved 应有 5 项：${JSON.stringify(l0.agent_models)}`,
      );
    }

    // ── 4/5. 卡状态机 + 打回上限：卡 1 先进 working（打回必须在非终态），三批 bounce 后
    //        再走完整两步返工链 reviewing → rework → working → reviewing → passed ──
    const step = (id, patch, label) => {
      const r = cardUpdate(project, id, patch);
      say(r.status === 0, `${label} 失败（${r.status}）：${r.stderr}`);
      say(r.stderr.includes('已更新'), `${label} 未提示已更新：${r.stderr}`);
      return r;
    };

    const w1 = step(1, { state: 'working' }, '卡1 pending→working');
    say(w1.stdout.includes('"state": "working"'), `卡1 working 的 stdout 未回显新状态：${w1.stdout}`);
    expectStep(1, 'working', 0, '卡1 working');

    // 打回（来源卡写卡 2）：前两批落 bounces，第三批转 deferred，reason 含「超限」。
    const bounce = (text) =>
      ledger(['bounce', '1', '--stdin'], { project, stdin: JSON.stringify({ text, source_card_id: '2' }) });
    for (let i = 1; i <= 2; i += 1) {
      const r = bounce(`第${i}批追加指令`);
      say(r.status === 0, `第 ${i} 批 bounce 退出码 ${r.status}：${r.stderr}`);
      say(r.stderr.includes(`已接收第 ${i} 批`), `第 ${i} 批 bounce 未提示已接收：${r.stderr}`);
    }
    const afterTwo = ledgerJson(project);
    const bouncedCard = (afterTwo.cards || []).find((c) => String(c.id) === '1') || {};
    say((bouncedCard.bounces || []).length === 2, `前 2 批应落 bounces（2 条），实际 ${JSON.stringify(bouncedCard.bounces)}`);
    say((afterTwo.deferred || []).length === 0, `前 2 批不应产生 deferred：${JSON.stringify(afterTwo.deferred)}`);
    const third = bounce('第3批追加指令');
    say(third.status === 0, `超限 bounce 应退出码 0（转 deferred），实际 ${third.status}：${third.stderr}`);
    say(third.stderr.includes('已转 deferred'), `超限 bounce 未提示转 deferred：${third.stderr}`);
    const afterThree = ledgerJson(project);
    const thirdCard = (afterThree.cards || []).find((c) => String(c.id) === '1') || {};
    say((thirdCard.bounces || []).length === 2, `第 3 批不应再进 bounces（应仍为 2），实际 ${(thirdCard.bounces || []).length}`);
    const deferred = afterThree.deferred || [];
    say(deferred.length === 1, `第 3 批应转 deferred（1 条），实际 ${JSON.stringify(deferred)}`);
    if (deferred[0]) {
      say(deferred[0].kind === 'bounce', `deferred kind 应为 bounce：${JSON.stringify(deferred[0].kind)}`);
      say(String(deferred[0].target_card_id) === '1', `deferred target_card_id 应为 1：${JSON.stringify(deferred[0].target_card_id)}`);
      say(String(deferred[0].card_id) === '2', `deferred 来源卡应为 2：${JSON.stringify(deferred[0].card_id)}`);
      say(String(deferred[0].reason || '').includes('超限'), `deferred reason 应含「超限」：${JSON.stringify(deferred[0].reason)}`);
    }

    const rv1 = step(1, { state: 'reviewing', result: { summary: '甲完成', files: ['src/a/x.mjs'] } }, '卡1 working→reviewing');
    say(rv1.stdout.includes('"state": "reviewing"'), `卡1 reviewing 的 stdout 未回显新状态：${rv1.stdout}`);
    expectStep(1, 'reviewing', 0, '卡1 首轮 reviewing');

    const rw = step(1, { state: 'rework', review: { verdict: 'FAIL', findings: ['需要补测试'] } }, '卡1 reviewing→rework');
    say(rw.stdout.includes('"state": "rework"'), `卡1 rework 的 stdout 未回显新状态：${rw.stdout}`);
    expectStep(1, 'rework', 1, '卡1 reviewing→rework');
    say(cardOf(1).review && cardOf(1).review.verdict === 'FAIL', `卡1 review 未落账：${JSON.stringify(cardOf(1).review)}`);

    const w2 = step(1, { state: 'working' }, '卡1 rework→working');
    say(w2.stderr.includes('round=1'), `卡1 返工后 working 的轮次提示应含 round=1：${w2.stderr}`);
    expectStep(1, 'working', 1, '卡1 返工 working');

    const rv2 = step(1, { state: 'reviewing', result: { summary: '甲返工完成', checks: ['补了测试'] } }, '卡1 返工后→reviewing');
    say(rv2.stdout.includes('"state": "reviewing"'), `卡1 返工后 reviewing 的 stdout 未回显新状态：${rv2.stdout}`);
    expectStep(1, 'reviewing', 1, '卡1 返工后 reviewing');

    const passed1 = step(1, { state: 'passed' }, '卡1 reviewing→passed');
    say(passed1.stdout.includes('"state": "passed"'), `卡1 passed 的 stdout 未回显新状态：${passed1.stdout}`);
    expectStep(1, 'passed', 1, '卡1 passed');

    // ── 6. finding --stdin：落一条发现 ──
    const finding = ledger(['finding', '--stdin'], { project, stdin: JSON.stringify({ text: '端到端发现一', card_id: '1' }) });
    say(finding.status === 0, `finding 退出码 ${finding.status}：${finding.stderr}`);
    say(finding.stderr.includes('已记录 finding'), `finding 未提示已记录：${finding.stderr}`);
    say(finding.stdout.includes('端到端发现一'), `finding stdout 未回显文本：${finding.stdout}`);
    const findings = ledgerJson(project).findings || [];
    say(findings.length === 1 && findings[0].text === '端到端发现一', `findings 应有 1 条「端到端发现一」：${JSON.stringify(findings)}`);

    // ── 7. spawn 1 --stdin：扩编出新卡 id=3，父卡 spawns 记归属 ──
    const spawned = ledger(['spawn', '1', '--stdin'], {
      project,
      stdin: JSON.stringify({ title: '扩编丙', task: '做丙', scope: 'src/c/', acceptance: '丙通过', role: 'builder' }),
    });
    let spawnCard = null;
    try { spawnCard = JSON.parse(spawned.stdout); } catch { /* 下面的断言会失败 */ }
    say(spawned.status === 0, `spawn 退出码 ${spawned.status}：${spawned.stderr}`);
    say(spawned.stderr.includes('已扩编'), `spawn 未提示已扩编：${spawned.stderr}`);
    say(spawnCard && String(spawnCard.id) === '3', `扩编卡 id 应为 3：${spawned.stdout}`);
    say(
      spawnCard && spawnCard.state === 'pending' && spawnCard.round === 0,
      `扩编卡应从 pending/round 0 起步：${JSON.stringify(spawnCard)}`,
    );
    const parentCard = cardOf(1);
    say(
      Array.isArray(parentCard.spawns) && parentCard.spawns.map(String).includes('3'),
      `父卡 #1 的 spawns 应记录 #3：${JSON.stringify(parentCard.spawns)}`,
    );

    // ── 8. 卡 2、卡 3 直接推到 passed（working → reviewing → passed） ──
    // 推卡 2 之前先看一眼中途报告：运行还在跑、卡 2 仍 pending，必须给出「待启动（next）」指引。
    const midReport = ledger(['report'], { project });
    say(midReport.status === 0, `中途 report 退出码 ${midReport.status}：${midReport.stderr}`);
    say(midReport.stdout.includes('待启动（next）'), `中途 report 应提示待启动的卡：${midReport.stdout.slice(0, 400)}`);
    say(midReport.stdout.includes('运行状态**：running'), `中途 report 的运行状态应为 running：${midReport.stdout.slice(0, 300)}`);
    for (const id of [2, 3]) {
      for (const state of ['working', 'reviewing', 'passed']) {
        const r = cardUpdate(project, id, { state });
        say(r.status === 0, `卡${id} → ${state} 失败（${r.status}）：${r.stderr}`);
        say(r.stdout.includes(`"state": "${state}"`), `卡${id} → ${state} 的 stdout 未回显新状态`);
      }
      expectStep(id, 'passed', 0, `卡${id} 终态`);
    }

    // ── 9. gate pass → fixer --stdin → finish completed ──
    const gate = ledger(['gate', 'pass'], { project });
    say(gate.status === 0, `gate pass 退出码 ${gate.status}：${gate.stderr}`);
    say(gate.stdout.includes('gate=pass') && gate.stdout.includes('rounds=1'), `gate stdout 不对：${gate.stdout}`);
    const fixer = ledger(['fixer', '--stdin'], {
      project,
      stdin: JSON.stringify({ summary: '端到端修复：补了回归', files: ['test/run.mjs'] }),
    });
    say(fixer.status === 0, `fixer 退出码 ${fixer.status}：${fixer.stderr}`);
    say(fixer.stderr.includes('已记录修复改动'), `fixer 未提示已记录：${fixer.stderr}`);
    say(fixer.stdout.includes('端到端修复：补了回归'), `fixer stdout 未回显摘要：${fixer.stdout}`);
    const fixedLedger = ledgerJson(project);
    say(fixedLedger.gate_status === 'pass' && fixedLedger.gate_rounds === 1, `gate 未落账：${JSON.stringify({ s: fixedLedger.gate_status, r: fixedLedger.gate_rounds })}`);
    say(
      Array.isArray(fixedLedger.fixer_changes) && fixedLedger.fixer_changes.length === 1 &&
        fixedLedger.fixer_changes[0].summary === '端到端修复：补了回归',
      `fixer_changes 未落账：${JSON.stringify(fixedLedger.fixer_changes)}`,
    );
    const finish = ledger(['finish', 'completed'], { project });
    say(finish.status === 0, `finish completed 退出码 ${finish.status}：${finish.stderr}`);
    say(finish.stdout.includes('已标记 completed'), `finish stdout 不对：${finish.stdout}`);
    const doneLedger = ledgerJson(project);
    say(doneLedger.status === 'completed', `finish 后台账 status 应为 completed，实际 ${JSON.stringify(doneLedger.status)}`);

    // ── 10. report：角色模型表用新契约，旧档位措辞/键名不得回潮 ──
    // 注意口径差异（以脚本实际行为为准）：markdown 报告里未开工卡写作「待启动（next）」，
    // 「待开工」是卡片显示链（board-card / report-card / 面板）的状态文案，故后者在 render 产物里断言。
    const report = ledger(['report'], { project });
    say(report.status === 0, `report 退出码 ${report.status}：${report.stderr}`);
    const reportText = String(report.stdout || '');
    for (const needle of ['团队角色模型', '任务分工表', '端到端发现一', '超限', '端到端修复：补了回归', '返工上限**：1 轮']) {
      say(reportText.includes(needle), `report 缺少「${needle}」`);
    }
    for (const stale of ['模型分工表', '卡档', 'resolved_models', '待施工']) {
      say(!reportText.includes(stale), `report 不应出现旧措辞/旧键「${stale}」`);
    }
    say(reportText.includes(BUILDER_MODEL), `report 未列出 builder 实际模型 ${BUILDER_MODEL}`);
    say(
      ['planner', 'architect', 'builder', 'reviewer', 'fixer'].every((role) => reportText.includes(role)),
      'report 的角色模型表未覆盖 5 个角色',
    );

    // ── 11. render board / render report：产物落盘、占位符无残留、DATA 可解析、卡片无 model ──
    const renderEnv = { ZCODE_GEN_UI_OUTPUT_ROOT: uiRoot, ZCODE_SESSION_ID: 'e2etest' };
    const renderBoard = ledger(['render', 'board'], { project, env: renderEnv });
    const renderReport = ledger(['render', 'report'], { project, env: renderEnv });
    say(renderBoard.status === 0 && renderBoard.stderr.includes('::visualize'), `render board 未产出 visualize 行：${renderBoard.stderr}`);
    say(renderReport.status === 0 && renderReport.stderr.includes('::visualize'), `render report 未产出 visualize 行：${renderReport.stderr}`);
    const outDir = join(uiRoot, 'zcode-swarm', 'e2etest');
    const outBoard = join(outDir, `swarm-board-${doneLedger.run_id}.html`);
    const outReport = join(outDir, `swarm-report-${doneLedger.run_id}.html`);
    // 产物路径必须落在 <root>/zcode-swarm/<session>/ 下（render 的目录契约）。
    say(renderBoard.stderr.replace(/\\/g, '/').includes(`/zcode-swarm/e2etest/swarm-board-`), `render board 产物路径不在会话目录下：${renderBoard.stderr}`);
    say(existsSync(outBoard), `未生成看板产物：${outBoard}`);
    say(existsSync(outReport), `未生成报告产物：${outReport}`);
    const dataOf = (html) => {
      if (html.includes('/*@@DATA@@*/') || html.includes('/*@@END@@*/')) return { err: '输出里残留 DATA 占位符' };
      const line = html
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.startsWith('var DATA = '));
      if (!line) return { err: '没找到 var DATA = 赋值行' };
      try {
        return { data: JSON.parse(line.slice('var DATA = '.length).replace(/;\s*$/, '')) };
      } catch (err) {
        return { err: `DATA 不是合法 JSON：${err.message}` };
      }
    };
    if (existsSync(outBoard)) {
      const html = readFileSync(outBoard, 'utf8');
      // 显示链文案：六态中文与面板/报告卡一致（pending = 待开工）。
      // 模板的兼容别名表里还留着「待施工」作旧值映射，那是合法兼容层，不作负向断言。
      say(html.includes('待开工'), '看板产物缺少状态文案「待开工」');
      const got = dataOf(html);
      say(!got.err, `看板产物：${got.err}`);
      if (got.data) {
        const data = got.data;
        say(Array.isArray(data.cards) && data.cards.length === 3, `看板 DATA 应有 3 张卡，实际 ${JSON.stringify(data.cards && data.cards.length)}`);
        say(
          Array.isArray(data.cards) && data.cards.every((c) => !Object.prototype.hasOwnProperty.call(c, 'model')),
          `看板 DATA 的卡片不应再有 model 字段：${JSON.stringify(data.cards)}`,
        );
        say(data.status === 'completed', `看板 DATA 的 status 应为 completed，实际 ${JSON.stringify(data.status)}`);
        say(data.gate && data.gate.status === 'pass', `看板 DATA 的 gate 应为 pass：${JSON.stringify(data.gate)}`);
        say(data.findings_count === 1 && data.deferred_count === 1, `看板 DATA 计数不对：${JSON.stringify({ f: data.findings_count, d: data.deferred_count })}`);
        const states = (data.cards || []).map((c) => c.state).join(',');
        say(states === 'passed,passed,passed', `看板 DATA 卡片状态应全为 passed，实际 ${states}`);
        // 运行级 phase/progress 的契约在「看板数据」资源（ui://zcode-swarm/board.json，见下）里；
        // 聊天卡片 DATA 目前只带卡片级字段。若以后也带上这两个字段，必须符合同一形状。
        if ('phase' in data) say(typeof data.phase === 'string' && data.phase !== '', `看板 DATA 的 phase 形状不对：${JSON.stringify(data.phase)}`);
        if ('progress' in data) {
          say(
            data.progress && typeof data.progress.total === 'number' && typeof data.progress.percent === 'number',
            `看板 DATA 的 progress 形状不对：${JSON.stringify(data.progress)}`,
          );
        }
      }
    }
    if (existsSync(outReport)) {
      const html = readFileSync(outReport, 'utf8');
      say(html.includes('待开工'), '报告产物缺少状态文案「待开工」');
      say(!html.includes('待施工'), '报告产物仍含旧文案「待施工」');
      say(!html.includes('模型分工表'), '报告产物仍含旧标题「模型分工表」');
      const got = dataOf(html);
      say(!got.err, `报告产物：${got.err}`);
      if (got.data) {
        const data = got.data;
        say(Array.isArray(data.cards) && data.cards.length === 3, `报告 DATA 应有 3 张卡，实际 ${JSON.stringify(data.cards && data.cards.length)}`);
        say(String(data.title || '').includes('3/3'), `报告 DATA 标题应含 3/3，实际 ${JSON.stringify(data.title)}`);
        // 报告卡的 model 是新契约：角色实际模型（inherit → 跟随会话），不是旧档位。
        const card1 = (data.cards || []).find((c) => String(c.id) === '1') || {};
        const card2 = (data.cards || []).find((c) => String(c.id) === '2') || {};
        const card3 = (data.cards || []).find((c) => String(c.id) === '3') || {};
        say(card1.model === BUILDER_MODEL, `报告卡 #1 的模型应为 ${BUILDER_MODEL}，实际 ${JSON.stringify(card1.model)}`);
        say(card2.model === '跟随会话', `报告卡 #2 的模型应为「跟随会话」，实际 ${JSON.stringify(card2.model)}`);
        say(card3.model === BUILDER_MODEL, `扩编卡 #3 的模型应为 ${BUILDER_MODEL}，实际 ${JSON.stringify(card3.model)}`);
        say(card1.rounds === 1, `报告卡 #1 的返工轮次应为 1，实际 ${JSON.stringify(card1.rounds)}`);
        say(
          !JSON.stringify(data.cards || []).match(/"model":"(light|strong|hard)"/),
          `报告 DATA 不应出现旧档位模型值：${JSON.stringify((data.cards || []).map((c) => c.model))}`,
        );
        say(
          data.agent_models && JSON.stringify(data.agent_models.resolved) === JSON.stringify(RESOLVED),
          `报告 DATA 的 agent_models 应与 init 写入一致：${JSON.stringify(data.agent_models)}`,
        );
        say(Array.isArray(data.findings) && data.findings.length === 1, `报告 DATA 应有 1 条 finding：${JSON.stringify(data.findings)}`);
        say(Array.isArray(data.deferred) && data.deferred.length === 1, `报告 DATA 应有 1 条 deferred：${JSON.stringify(data.deferred)}`);
      }
    }
    // 「看板数据」（面板服务 ui://zcode-swarm/board.json，与 render 同源台账）必须带 phase 与 progress。
    const readBoard = JSON.stringify({
      jsonrpc: '2.0',
      id: 91,
      method: 'resources/read',
      params: { uri: BOARD_URI },
    });
    const panel = spawnSync(process.execPath, [BOARD_SERVER], {
      input: `${readBoard}\n`,
      encoding: 'utf8',
      cwd: project,
      env: { ...process.env, ZCODE_WORKSPACE_ROOT: project, SWARM_PROJECT: '' },
      timeout: 20000,
    });
    say(panel.status === 0, `看板服务退出码 ${panel.status}：${panel.stderr}`);
    let boardData = null;
    try {
      const messages = String(panel.stdout || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
      boardData = boardOf(messages, 91);
    } catch (err) {
      fails.push(`看板服务输出无法解析：${err.message}`);
    }
    say(!!boardData, `看板资源没有返回数据：${panel.stdout}`);
    if (boardData) {
      say(typeof boardData.phase === 'string' && boardData.phase !== '', `看板数据缺 phase：${JSON.stringify(boardData.phase)}`);
      say(boardData.phase === 'done', `运行已完成时看板 phase 应为 done，实际 ${JSON.stringify(boardData.phase)}`);
      say(
        boardData.progress && boardData.progress.total === 3 && boardData.progress.settled === 3 && boardData.progress.percent === 100,
        `看板数据 progress 应为 3/3 已结算、100%：${JSON.stringify(boardData.progress)}`,
      );
      say(
        Array.isArray(boardData.cards) && boardData.cards.length === 3 && boardData.cards.every((c) => !('model' in c)),
        `看板数据卡片应为 3 张且无 model 字段：${JSON.stringify(boardData.cards)}`,
      );
    }

    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(uiRoot, { recursive: true, force: true });
  }
});

// 39 视觉回归（无头可选资产）：board 分段条/大数字、report 英雄区、无横向滚动、点击展开冒烟
await caseCheckAsync('visual-regression-cards', async () => {
  const createProbe = (await import('./visual-probe.mjs')).default;
  const probe = await createProbe();
  if (!probe) return { ok: true, skipped: true, detail: 'SKIP：本机无可探测 Chrome，视觉回归跳过' };
  const fails = [];
  const dir = tmpProject();
  try {
    // 一份混合状态的台账：2 passed + 1 working + 1 rework，让分段条有多种颜色段
    const init = ledgerInit(dir, {
      requirement: '视觉回归', gate: 'node test/run.mjs',
      cards: [
        { title: '甲', task: 't', scope: 'a/', acceptance: 'ok', role: 'builder' },
        { title: '乙', task: 't', scope: 'b/', acceptance: 'ok', role: 'builder' },
        { title: '丙', task: 't', scope: 'c/', acceptance: 'ok', role: 'builder' },
        { title: '丁', task: 't', scope: 'd/', acceptance: 'ok', role: 'builder' },
      ],
    });
    if (init.status !== 0) return { ok: false, detail: `init 失败：${init.stderr}` };
    for (const [id, states] of [[1, ['working', 'reviewing', 'passed']], [2, ['working', 'reviewing', 'passed']]]) {
      for (const st of states) await cardUpdate(dir, id, { state: st });
    }
    await cardUpdate(dir, 3, { state: 'working' });
    await cardUpdate(dir, 4, { state: 'working' });
    await cardUpdate(dir, 4, { state: 'reviewing' });
    await cardUpdate(dir, 4, { state: 'rework', review: { verdict: 'FAIL', findings: ['x'] } });

    const uiRoot = mkdtempSync(join(tmpdir(), 'zswarm-vp-run-'));
    const render = (kind) => ledger(['render', kind], { project: dir, env: { ZCODE_GEN_UI_OUTPUT_ROOT: uiRoot, ZCODE_SESSION_ID: 'vptest' } });
    const rb = render('board');
    if (rb.status !== 0) return { ok: false, detail: `render board 失败：${rb.stderr}` };
    const boardHtml = readFileSync(join(uiRoot, 'zcode-swarm', 'vptest', `swarm-board-${JSON.parse(readFileSync(ledgerPathOf(dir), 'utf8')).run_id}.html`), 'utf8');
    const rr = render('report');
    if (rr.status !== 0) return { ok: false, detail: `render report 失败：${rr.stderr}` };
    const reportHtml = readFileSync(join(uiRoot, 'zcode-swarm', 'vptest', `swarm-report-${JSON.parse(readFileSync(ledgerPathOf(dir), 'utf8')).run_id}.html`), 'utf8');

    const boardPage = await probe.open(boardHtml, 'board');
    try {
      if (probe.level === 'playwright') {
        const info = await boardPage.eval(() => {
          const root = document.getElementById('zcode-swarm-board');
          return {
            segs: document.querySelectorAll('.zb-seg').length,
            nums: (document.getElementById('zb-nums') || {}).textContent || '',
            hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            rows: document.querySelectorAll('button.zb-row').length,
          };
        });
        if (info.segs < 2) fails.push(`分段条应 ≥2 段（passed+working+rework），实际 ${info.segs}`);
        if (!/^2\/4$/.test(info.nums.trim())) fails.push(`大数字应为 2/4，实际 ${JSON.stringify(info.nums)}`);
        if (info.hScroll) fails.push('board 卡出现横向滚动');
        // 点击展开冒烟：点第一张卡（passed 卡有详情数据）
        const clicked = await boardPage.clickFirst('button.zb-row');
        if (!clicked) fails.push('没有可点击的卡片行');
        else {
          const open = await boardPage.eval(() => Boolean(document.querySelector('.zb-row[data-open="true"], .zb-detail')));
          if (!open) fails.push('点击后未出现展开态/详情');
        }
        if (boardPage.errors.length) fails.push(`board 页面错误：${boardPage.errors.join(' | ')}`);
      } else {
        if (!boardPage.dom.includes('zb-segbar')) fails.push('dump-dom 里没有分段条');
        if (!boardPage.dom.includes('zb-nums')) fails.push('dump-dom 里没有大数字节点');
      }
    } finally { await boardPage.cleanup(); }

    const reportPage = await probe.open(reportHtml, 'report');
    try {
      if (probe.level === 'playwright') {
        const hero = await reportPage.eval(() => Boolean(document.querySelector('.zr-nums, .zr-score, [class*="zr-hero"], .zr-tile')));
        if (!hero) fails.push('report 卡缺少英雄区/磁贴节点');
        const noTable = await reportPage.eval(() => document.querySelectorAll('table, .form-label').length === 0);
        if (!noTable) fails.push('report 卡不应再有 table/form-label');
        if (reportPage.errors.length) fails.push(`report 页面错误：${reportPage.errors.join(' | ')}`);
      } else if (!reportPage.dom.includes('zr-')) fails.push('dump-dom 里没有报告卡类名');
    } finally { await reportPage.cleanup(); }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await probe.done();
  }
});

// 40 EMBEDDED 快照载荷：requirement 含 </script> 与占位符字面量时，数据完整转义、页面无脚本错误
await caseCheckAsync('embedded-script-payload', async () => {
  const createProbe = (await import('./visual-probe.mjs')).default;
  const probe = await createProbe();
  if (!probe || probe.level !== 'playwright') return { ok: true, skipped: true, detail: 'SKIP：需要 playwright 级探针' };
  const fails = [];
  const dir = tmpProject();
  try {
    const payload = '含 </script> 与 /*@@END@@*/ 与 <img src=x onerror=window.__pwned=1> 的需求文本';
    const init = ledgerInit(dir, { requirement: payload, gate: '', cards: [{ title: '载荷卡', task: 't', scope: 'a/', acceptance: 'ok', role: 'builder' }] });
    if (init.status !== 0) return { ok: false, detail: `init 失败：${init.stderr}` };
    await cardUpdate(dir, 1, { state: 'working' });
    await cardUpdate(dir, 1, { state: 'reviewing', result: { summary: 'ok </script>' } });
    await cardUpdate(dir, 1, { state: 'passed' });
    const uiRoot = mkdtempSync(join(tmpdir(), 'zswarm-vp-payload-'));
    const rb = ledger(['render', 'board'], { project: dir, env: { ZCODE_GEN_UI_OUTPUT_ROOT: uiRoot, ZCODE_SESSION_ID: 'vptest' } });
    if (rb.status !== 0) return { ok: false, detail: `render 失败：${rb.stderr}` };
    const runId = JSON.parse(readFileSync(ledgerPathOf(dir), 'utf8')).run_id;
    const html = readFileSync(join(uiRoot, 'zcode-swarm', 'vptest', `swarm-board-${runId}.html`), 'utf8');
    const page = await probe.open(html, 'payload');
    try {
      const info = await page.eval(() => ({
        pwned: window.__pwned === undefined,
        imgCount: document.querySelectorAll('img').length,
        rows: document.querySelectorAll('.zb-row').length,
      }));
      if (!info.pwned) fails.push('onerror 载荷被执行了（window.__pwned 被置位）');
      if (info.imgCount !== 0) fails.push(`DOM 出现 ${info.imgCount} 个 img（载荷未按文本处理）`);
      if (info.rows !== 1) fails.push(`EMBEDDED 解析后应 1 张卡，实际 ${info.rows}`);
      if (page.errors.length) fails.push(`页面脚本错误：${page.errors.join(' | ')}`);
      return { ok: fails.length === 0, detail: fails.join('；') };
    } finally { await page.cleanup(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await probe.done();
  }
});

// 41 watchdog 巡检：超时卡出 [STALE]/[KILL] 事实行（含 agent_id 与建议），无超时/非 running 静默
caseCheck('ledger-watchdog-stale-kill', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: 'wd', gate: '', cards: [
      { title: '超时卡', task: 't', scope: 'a/', acceptance: 'ok', role: 'r', agent_id: 'agent_wd' },
      { title: '新鲜卡', task: 't', scope: 'b/', acceptance: 'ok', role: 'r' },
    ] });
    if (init.status !== 0) return { ok: false, detail: `init 失败：${init.stderr}` };
    for (const id of [1, 2]) cardUpdate(dir, id, { state: 'working' });
    // 把卡 1 的 updated_at 拨回 100 分钟前 → KILL；卡 2 保持刚刚 → 不出现
    const path = ledgerPathOf(dir);
    const d = JSON.parse(readFileSync(path, 'utf8'));
    const old = new Date(Date.now() - 100 * 60000).toISOString();
    d.cards[0].updated_at = old;
    writeFileSync(path, JSON.stringify(d, null, 2), 'utf8');
    const wd = ledger(['watchdog'], { project: dir });
    if (wd.status !== 0) fails.push(`watchdog 退出码 ${wd.status}（应恒 0）`);
    if (!wd.stdout.includes('[KILL] 卡 #1')) fails.push(`应输出 KILL 卡 #1，实际：${wd.stdout}`);
    if (!wd.stdout.includes('agent_id=agent_wd')) fails.push('KILL 行应含 agent_id');
    if (!wd.stdout.includes('新鲜卡') && wd.stdout.includes('卡 #2')) fails.push('新鲜卡不应出现在巡检输出');
    // ② STALE 区间：卡 1 拨回 45 分钟（30–90 阈值之间）、卡 2 复位新鲜 → [STALE] 且该行建议 TaskOutput，不应判死
    const dStale = JSON.parse(readFileSync(path, 'utf8'));
    dStale.cards[0].updated_at = new Date(Date.now() - 45 * 60000).toISOString();
    dStale.cards[1].updated_at = new Date().toISOString();
    writeFileSync(path, JSON.stringify(dStale, null, 2), 'utf8');
    const wdStale = ledger(['watchdog'], { project: dir });
    if (wdStale.status !== 0) fails.push(`watchdog(STALE) 退出码 ${wdStale.status}（应恒 0）`);
    if (!wdStale.stdout.includes('[STALE] 卡 #1')) fails.push(`45 分钟应出 STALE 卡 #1，实际：${wdStale.stdout}`);
    if (wdStale.stdout.includes('[KILL]')) fails.push(`45 分钟不应判死 KILL，实际：${wdStale.stdout}`);
    const staleLines = wdStale.stdout.split('\n').filter((l) => l.includes('[STALE]'));
    if (staleLines.length !== 1) fails.push(`STALE 行应恰好 1 条，实际 ${staleLines.length}：${wdStale.stdout}`);
    for (const l of staleLines) if (!l.includes('TaskOutput')) fails.push(`STALE 行应含 TaskOutput 建议，实际：${l}`);
    // ① agent_id 缺失：卡 2（建卡时无 agent_id 字段）拨回 45 分钟、卡 1 复位 → 超时行逐字含缺失提示
    const dAid = JSON.parse(readFileSync(path, 'utf8'));
    dAid.cards[0].updated_at = new Date().toISOString();
    dAid.cards[1].updated_at = new Date(Date.now() - 45 * 60000).toISOString();
    writeFileSync(path, JSON.stringify(dAid, null, 2), 'utf8');
    const wdAid = ledger(['watchdog'], { project: dir });
    if (wdAid.status !== 0) fails.push(`watchdog(缺失) 退出码 ${wdAid.status}（应恒 0）`);
    const missLines = wdAid.stdout.split('\n').filter((l) => l.includes('卡 #2'));
    if (missLines.length !== 1) fails.push(`无 agent_id 的超时卡 #2 应恰好 1 行，实际 ${missLines.length}：${wdAid.stdout}`);
    else if (!missLines[0].includes('agent_id 缺失（下批派工记得 update 落 agent_id）')) fails.push(`agent_id 缺失文案应逐字对齐，实际：${missLines[0]}`);
    else if (!missLines[0].includes('[STALE]')) fails.push(`缺失 agent_id 的超时行应带 [STALE]，实际：${missLines[0]}`);
    // 无超时：全部拨到当前 → 静默（无 KILL/STALE 行）
    const d2 = JSON.parse(readFileSync(path, 'utf8'));
    const nowIso = new Date().toISOString();
    d2.cards[0].updated_at = nowIso;
    d2.cards[1].updated_at = nowIso;
    writeFileSync(path, JSON.stringify(d2, null, 2), 'utf8');
    const wd2 = ledger(['watchdog'], { project: dir });
    if (wd2.status !== 0 || /\[(STALE|KILL)\]/.test(wd2.stdout)) fails.push(`无超时时应静默，实际：${wd2.stdout}`);
    // run 结束后：静默
    ledger(['finish', 'failed'], { project: dir });
    const wd3 = ledger(['watchdog'], { project: dir });
    if (wd3.status !== 0 || /\[(STALE|KILL)\]/.test(wd3.stdout)) fails.push(`非 running 应静默，实际：${wd3.stdout}`);
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 42 接管重做（failed → working，主会话接管重做 builder 死亡卡）：无 {takeover:true} 仍按终态拒绝；
// 带标记解锁，round 归零、error 清空、takeover_count 记卡上且逐次累加（供报告披露接管次数）
caseCheck('ledger-failed-takeover-working', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: '接管重做', cards: [{ title: '翻车卡' }], gate: '' });
    if (init.status !== 0) return { ok: false, detail: `init 失败（${init.status}）：${init.stderr}` };
    // 前置：把卡推到 failed，且带一轮返工记录（round=1）与错误信息，模拟 builder 死亡（insufficient_balance）
    for (const [patch, label] of [
      [{ state: 'working' }, 'pending→working'],
      [{ state: 'reviewing' }, 'working→reviewing'],
      [{ state: 'rework' }, 'reviewing→rework'],
      [{ state: 'working' }, 'rework→working'],
      [{ state: 'reviewing' }, 'working→reviewing'],
      [{ state: 'failed', error: 'builder 死亡：insufficient_balance' }, 'reviewing→failed'],
    ]) {
      const r = cardUpdate(dir, 1, patch);
      if (r.status !== 0) return { ok: false, detail: `${label} 失败（${r.status}）：${r.stderr}` };
    }
    const dead = ledgerJson(dir).cards.find((c) => c.id === '1');
    if (dead.state !== 'failed' || dead.round !== 1 || !dead.error) {
      return { ok: false, detail: `前置失败：failed 卡应 round=1 且有 error，实际 ${JSON.stringify({ state: dead.state, round: dead.round, error: dead.error })}` };
    }

    // 无标记：退出码 2，报错信息说明需 takeover；卡不被洗动（仍 failed、round/error 原样）
    const noFlag = cardUpdate(dir, 1, { state: 'working' });
    if (noFlag.status !== 2 || !noFlag.stderr.includes('takeover')) {
      fails.push(`无标记 failed→working 应退出码 2 且报错含 takeover，实际 ${noFlag.status}：${noFlag.stderr}`);
    }
    const still = ledgerJson(dir).cards.find((c) => c.id === '1');
    if (still.state !== 'failed' || still.round !== 1 || !still.error) {
      fails.push(`无标记转移被拒后卡应原样（failed/round=1/error 在），实际 ${JSON.stringify({ state: still.state, round: still.round, error: still.error })}`);
    }

    // 带 {takeover:true}：解锁；round 归零、error 清空、takeover_count=1 落在卡上
    const take = cardUpdate(dir, 1, { state: 'working', takeover: true });
    if (take.status !== 0) fails.push(`带 takeover 的 failed→working 应成功，实际 ${take.status}：${take.stderr}`);
    const card = ledgerJson(dir).cards.find((c) => c.id === '1');
    if (card.state !== 'working') fails.push(`接管后 state 应为 working，实际 ${card.state}`);
    if (card.round !== 0) fails.push(`接管后 round 应归零，实际 ${card.round}`);
    if (card.error !== null) fails.push(`接管后 error 应清空，实际 ${JSON.stringify(card.error)}`);
    if (card.takeover_count !== 1) fails.push(`接管后 takeover_count 应为 1，实际 ${JSON.stringify(card.takeover_count)}`);

    // 再次失败再接管：takeover_count 累加到 2（披露接管次数的依据）
    const failAgain = cardUpdate(dir, 1, { state: 'failed', error: '二次死亡' });
    if (failAgain.status !== 0) fails.push(`working→failed 应成功，实际 ${failAgain.status}：${failAgain.stderr}`);
    const retake = cardUpdate(dir, 1, { state: 'working', takeover: true });
    if (retake.status !== 0) fails.push(`第二次接管应成功，实际 ${retake.status}：${retake.stderr}`);
    const final = ledgerJson(dir).cards.find((c) => c.id === '1');
    if (final.state !== 'working' || final.takeover_count !== 2) {
      fails.push(`二次接管后应 working 且 takeover_count=2，实际 ${JSON.stringify({ state: final.state, takeover_count: final.takeover_count })}`);
    }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 42 收尾硬闸：有未终态卡时 gate/finish completed 拒绝（0/5 假失败事故回归），全终态后放行
caseCheck('ledger-finish-gate-terminal-guard', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: '收尾硬闸', gate: 'node test/run.mjs', cards: [
      { title: '甲', task: 't', scope: 'a/', acceptance: 'ok', role: 'r' },
      { title: '乙', task: 't', scope: 'b/', acceptance: 'ok', role: 'r' },
    ] });
    if (init.status !== 0) return { ok: false, detail: `init 失败：${init.stderr}` };
    // 两卡都推到 reviewing（未终态）
    for (const id of [1, 2]) {
      cardUpdate(dir, id, { state: 'working' });
      cardUpdate(dir, id, { state: 'reviewing', result: { summary: 'ok' } });
    }
    // 闸 A：有 reviewing 卡时 gate 拒绝并列出卡
    const gate = ledger(['gate', 'pass'], { project: dir });
    if (gate.status !== 2) fails.push(`gate 在未终态时应拒绝（exit 2），实际 ${gate.status}：${gate.stdout}`);
    if (!gate.stderr.includes('未到终态')) fails.push('gate 报错应说明存在未终态卡');
    if (!gate.stderr.includes('#1[reviewing]')) fails.push('gate 报错应列出未终态卡清单');
    // 闸 B：finish completed 同样拒绝
    const fin = ledger(['finish', 'completed'], { project: dir });
    if (fin.status !== 2) fails.push(`finish completed 在未终态时应拒绝（exit 2），实际 ${fin.status}：${fin.stdout}`);
    if (!fin.stderr.includes('不能标记 completed')) fails.push('finish 报错应说明不能标记 completed');
    if (!fin.stderr.includes('finish failed')) fails.push('finish 报错应指引 finish failed 出路');
    // 全终态后：gate 与 finish 放行
    for (const id of [1, 2]) cardUpdate(dir, id, { state: 'passed' });
    const gate2 = ledger(['gate', 'pass'], { project: dir });
    if (gate2.status !== 0) fails.push(`全终态后 gate 应放行，实际 ${gate2.status}：${gate2.stderr}`);
    const fin2 = ledger(['finish', 'completed'], { project: dir });
    if (fin2.status !== 0) fails.push(`全终态后 finish completed 应放行，实际 ${fin2.status}：${fin2.stderr}`);
    // finish failed 宽松性保持：新运行有未终态卡仍允许 failed 收尾（崩溃/放弃场景）
    const dir2 = tmpProject();
    try {
      ledgerInit(dir2, { requirement: 'x', gate: '', cards: [{ title: 'a', task: 't', scope: 'a/', acceptance: 'ok', role: 'r' }] });
      cardUpdate(dir2, 1, { state: 'working' });
      const fin3 = ledger(['finish', 'failed'], { project: dir2 });
      if (fin3.status !== 0) fails.push(`finish failed 宽松收尾被破坏，实际 ${fin3.status}：${fin3.stderr}`);
    } finally { rmSync(dir2, { recursive: true, force: true }); }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 43 MCP 内嵌新版看板锁定：_meta.ui 必须指向 board.html（新版设计），不得指向 panel.html（旧侧栏设计）
caseCheck('board-server-inline-board-html', () => {
  const s = readFileSync(join(REPO, 'scripts', 'swarm-board-server.mjs'), 'utf8');
  const toolsSection = s.slice(s.indexOf('const TOOLS'), s.indexOf('/** 方法分发表'));
  const fails = [];
  if (!/_meta\s*:\s*\{\s*ui\s*:\s*\{\s*resourceUri\s*:\s*BOARD_CARD_URI/.test(toolsSection)) fails.push('_meta.ui.resourceUri 必须指向 BOARD_CARD_URI（新版看板）');
  if (toolsSection.includes('resourceUri: PANEL_URI')) fails.push('_meta.ui 不得指向 PANEL_URI（旧侧栏设计，是双看板丑陋根因）');
  // board.html 资源注册与读取处理
  const resourcesSection = s.slice(s.indexOf('const RESOURCES'), s.indexOf('const TOOLS'));
  if (!resourcesSection.includes('BOARD_CARD_URI')) fails.push('RESOURCES 必须注册 board.html 资源');
  if (!s.includes("uri === BOARD_CARD_URI")) fails.push('resources/read 必须处理 BOARD_CARD_URI');
  return { ok: fails.length === 0, detail: fails.join('；') };
});

// 43 watchdog 补 pending 未派工扫描：init 后长期 pending 的卡出 [NOT-DISPATCHED] 行
caseCheck('ledger-watchdog-pending-undispatched', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: '未派工', gate: '', cards: [
      { title: '未派工卡', task: 't', scope: 'a/', acceptance: 'ok', role: 'r' },
    ] });
    if (init.status !== 0) return { ok: false, detail: `init 失败：${init.stderr}` };
    const path = ledgerPathOf(dir);
    const d = JSON.parse(readFileSync(path, 'utf8'));
    const old = new Date(Date.now() - 40 * 60000).toISOString();
    d.cards[0].updated_at = old;
    d.updated_at = old;
    writeFileSync(path, JSON.stringify(d, null, 2), 'utf8');
    const wd = ledger(['watchdog'], { project: dir });
    if (wd.status !== 0) fails.push(`watchdog 退出码 ${wd.status}（应恒 0）`);
    if (!wd.stdout.includes('[NOT-DISPATCHED] 卡 #1')) fails.push(`应输出 NOT-DISPATCHED 行，实际：${wd.stdout}`);
    if (!wd.stdout.includes('未派工')) fails.push('应说明 pending 未派工');
    // 刚 init 的 pending 卡不应报（阈值内）
    const fresh = tmpProject();
    try {
      ledgerInit(fresh, { requirement: 'f', gate: '', cards: [{ title: 'a', task: 't', scope: 'a/', acceptance: 'ok', role: 'r' }] });
      const wd2 = ledger(['watchdog'], { project: fresh });
      if (/\[NOT-DISPATCHED\]/.test(wd2.stdout)) fails.push('刚 init 的 pending 卡不应报 NOT-DISPATCHED');
    } finally { rmSync(fresh, { recursive: true, force: true }); }
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 44 中途消息路由：route 命令输出卡状态+范围+路由建议（匹配在飞卡/新工作/取消/无蜂群）
caseCheck('ledger-route-midrun', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: '路由', gate: '', cards: [
      { title: '音效模块 sound', task: 't', scope: 'src/sound/', acceptance: 'ok', role: 'r', agent_id: 'ag_r1' },
      { title: '特效系统', task: 't', scope: 'src/fx/', acceptance: 'ok', role: 'r' },
    ] });
    if (init.status !== 0) return { ok: false, detail: `init 失败：${init.stderr}` };
    cardUpdate(dir, 1, { state: 'working' });
    cardUpdate(dir, 2, { state: 'working' });

    // 场景 A：匹配在飞卡（音效）→ 建议 bounce
    const ra = ledger(['route', '音效改一下频率'], { project: dir });
    if (ra.status !== 0) fails.push(`route exit ${ra.status}`);
    if (!ra.stdout.includes('#1[working]')) fails.push('应列出卡 #1 状态');
    if (!ra.stdout.includes('scope=src/sound/')) fails.push('应列出卡 #1 范围');
    if (!ra.stdout.includes('bounce')) fails.push('匹配在飞卡应建议 bounce');

    // 场景 B：取消 → 建议 failed
    const rb = ledger(['route', '算了 不要了'], { project: dir });
    if (!rb.stdout.includes('取消')) fails.push('取消类应含「取消」');
    if (!rb.stdout.includes('failed')) fails.push('取消类应建议 failed');

    // 场景 C：无蜂群（空项目）→ 静默
    const empty = tmpProject();
    try {
      const rc = ledger(['route', '随便'], { project: empty });
      if (rc.status !== 0) fails.push(`无蜂群 route exit ${rc.status}（应恒 0）`);
      if (/\[RUN\]/.test(rc.stdout)) fails.push('无蜂群不应输出 [RUN]');
    } finally { rmSync(empty, { recursive: true, force: true }); }

    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 44 agent_id 存在性验证：不存在的 agent_id 写 working 被拒，存在的放行
caseCheck('ledger-agent-id-existence', () => {
  const dir = tmpProject();
  const fails = [];
  try {
    const init = ledgerInit(dir, { requirement: 'agent_id 验证', gate: '', cards: [{ title: 'a', task: 't', scope: 'a/', acceptance: 'ok', role: 'r' }] });
    if (init.status !== 0) return { ok: false, detail: `init 失败：${init.stderr}` };
    // 假 agent_id → 拒绝
    const bad = cardUpdate(dir, 1, { state: 'working', agent_id: 'definitely-not-real-agent-xyz' });
    if (bad.status !== 2) fails.push(`假 agent_id 应被拒（exit 2），实际 ${bad.status}：${bad.stdout}`);
    if (!bad.stderr.includes('不存在')) fails.push('报错应含「不存在」');
    // 真 agent_id（用本会话已有的）→ 通过
    const realId = 'agent_fb488e04-85a2-4fac-be59-e1e47a270dfe';
    const good = cardUpdate(dir, 1, { state: 'working', agent_id: realId });
    if (good.status !== 0) fails.push(`真 agent_id 应通过，实际 ${good.status}：${good.stderr}`);
    return { ok: fails.length === 0, detail: fails.join('；') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 45 自动化特性：board.html 含自动刷新脚本；watchdog 自注册清理
caseCheck('automation-features', () => {
  const serverSrc = readFileSync(join(REPO, 'scripts', 'swarm-board-server.mjs'), 'utf8');
  const ledgerSrc = readFileSync(join(REPO, 'scripts', 'swarm-ledger.mjs'), 'utf8');
  const fails = [];
  // board.html 含自动刷新脚本（postMessage + 3秒轮询）
  if (!serverSrc.includes('swarm-refresh-') && !serverSrc.includes('setTimeout(tick,3000)')) fails.push('board.html 缺少自动刷新脚本');
  if (!serverSrc.includes('resources/read')) fails.push('自动刷新应请求 resources/read');
  // watchdog 自注册（marker 文件）
  if (!ledgerSrc.includes('swarm-watchdog-') && !ledgerSrc.includes('markerPath')) fails.push('watchdog 应自注册定时器（marker 文件）');
  // finish 清理定时器
  if (!ledgerSrc.includes('unlinkSync') || !ledgerSrc.includes('swarm-watchdog-')) fails.push('finish 应清理 watchdog 定时器');
  // SKILL 中 render board 改为可选
  const skillSrc = readFileSync(join(REPO, 'skills', 'swarm', 'SKILL.md'), 'utf8');
  if (!skillSrc.includes('optionally') && !skillSrc.includes('auto-refreshes')) fails.push('SKILL 应将 render board 改为可选（MCP 面板自动刷新）');
  return { ok: fails.length === 0, detail: fails.join('；') };
});

const failed = results.filter((r) => !r.ok && !r.skipped);
const skipped = results.filter((r) => r.skipped);
console.log(`\n${results.length - failed.length - skipped.length}/${results.length} 通过，${skipped.length} 跳过，${failed.length} 失败`);
process.exit(failed.length > 0 ? 1 : 0);


