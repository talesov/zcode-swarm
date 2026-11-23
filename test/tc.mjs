// 用引擎自带 facade（从 dynamic-workflows 技能里抽）对团队工作流模板做类型检查。
// 用法：node test/tc.mjs <workflow.dwf.ts> [...]
// TypeScript 安装位置：env TSC_PATH（指向 typescript 包目录）或若干已知本机位置；找不到就退出码 3（SKIP）。
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const TS_CANDIDATES = [
  process.env.TSC_PATH,
  'C:/Trae_workspace/token-monitor-lite/node_modules/typescript',
  'C:/Trae_workspace/godot-mcp/node_modules/typescript',
  'typescript',
].filter(Boolean);
let ts = null;
for (const candidate of TS_CANDIDATES) {
  try {
    ts = require(candidate.endsWith('typescript') && !candidate.includes('node_modules') ? candidate : `${candidate}/package.json`) && require(candidate);
    if (ts && ts.createProgram) break;
  } catch {
    ts = null;
  }
}
if (!ts || !ts.createProgram) {
  console.log('SKIP tc: 找不到 typescript（设 env TSC_PATH 指向其包目录）');
  process.exit(3);
}

const installDir = process.env.ZCODE_WINDOWS_APP_INSTALL_DIR;
const SKILL_CANDIDATES = [
  process.env.ZCODE_SKILL_PATH,
  installDir && `${installDir}/resources/glm/packages/bundled-skills/skills/dynamic-workflows/SKILL.md`,
  'C:/Program Files/ZCode/resources/glm/packages/bundled-skills/skills/dynamic-workflows/SKILL.md',
  'E:/Agent/Zcode/resources/glm/packages/bundled-skills/skills/dynamic-workflows/SKILL.md',
].filter(Boolean);
const SKILL = SKILL_CANDIDATES.find(existsSync);
if (!SKILL) {
  console.log('SKIP tc: 找不到 dynamic-workflows SKILL.md（设 env ZCODE_SKILL_PATH）');
  process.exit(3);
}
const skill = readFileSync(SKILL, 'utf8');
const facade = skill
  .split('<!-- facade-dts:start -->')[1]
  .split('<!-- facade-dts:end -->')[0]
  .replace(/^\s*```ts\s*$/m, '')
  .replace(/^\s*```\s*$/m, '');

const dir = mkdtempSync(join(tmpdir(), 'swarm-tc-'));
try {
  const facadePath = join(dir, 'facade.d.ts');
  writeFileSync(facadePath, facade, 'utf8');
  let failed = false;
  for (const target of process.argv.slice(2)) {
    const scriptPath = join(dir, 'script.ts');
    // 运行体是 async 函数体（顶层 await 与最终 return 合法）：按引擎降级方式包一层
    writeFileSync(scriptPath, `export {};\nasync function __run() {\n${readFileSync(target, 'utf8')}\n}\nvoid __run;\n`, 'utf8');
    const program = ts.createProgram([facadePath, scriptPath], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      lib: ['lib.es2022.d.ts'],
      types: [],
      skipLibCheck: true,
    });
    const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
    const diags = ts.getPreEmitDiagnostics(program).filter((d) => !d.file || norm(d.file.fileName) === norm(scriptPath));
    console.log(`tc ${target}: ${diags.length} diagnostic(s)`);
    for (const d of diags) {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      if (d.file && d.start !== undefined) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        console.log(`  L${line - 1}:${character + 1} TS${d.code} ${msg}`);
      } else console.log(`  TS${d.code} ${msg}`);
    }
    if (diags.length) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
