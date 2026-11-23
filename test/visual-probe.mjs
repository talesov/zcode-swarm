#!/usr/bin/env node
/**
 * visual-probe — 无头视觉探针助手（zcode-swarm 可选回归资产）。
 *
 * 零依赖原则的受控例外：本模块只在本机探测到可用 Chrome 时才有意义，
 * 探测不到时导出 null，调用方打印 SKIP（SKIP 不算失败，与 run.mjs 既有纪律一致）。
 * 绝不 npm install——playwright-core 若存在就用（三级探测），不存在退到 Chrome 自带
 * --headless --dump-dom（只支持静态 DOM 断言；点击冒烟需要 playwright 级别）。
 *
 * 用法（run.mjs 内）：
 *   const createProbe = (await import('./visual-probe.mjs')).default;
 *   const probe = await createProbe();   // 每个用例自建自毁（用例间浏览器不共享）
 *   if (!probe) → SKIP
 *   const page = await probe.open(htmlString);        // 自动包 doctype/主题变量，data: URL 加载
 *   const info = await page.eval(() => {...});        // DOM 断言
 *   await probe.done();                               // 关浏览器
 */

import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

/* ---------- Chrome 探测 ---------- */
const CHROME_CANDIDATES = [
  process.env.CHROME_EXE,
  'C:/Users/AA/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

/* ---------- DOM 快照兜底：chrome --headless --dump-dom ---------- */
function dumpDom(chrome, url) {
  const r = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=2500',
    '--dump-dom', url,
  ], { encoding: 'utf8', timeout: 30000 });
  return r.status === 0 ? r.stdout : '';
}

/* ---------- 打包独立页（主题变量 fallback，深浅皆可读） ---------- */
const THEME_FALLBACK = `<style>:root{--background:#fff;--foreground:#171717;--muted:#f5f5f5;--muted-foreground:#737373;--border:#e5e5e5;--primary:#2563eb;--destructive:#dc2626;--card:#fff;--green:#16a34a;--yellow:#ca8a04;--blue:#2563eb;--red:#dc2626;--purple:#8b5cf6}body{background:var(--background);color:var(--foreground);font-family:system-ui,sans-serif;margin:0;padding:16px}</style>`;

/** 把 Gen UI 片段（board/report 卡）包成可独立打开的页面并返回 file:// URL。 */
export function standaloneUrl(fragmentHtml, tag = 'probe') {
  const dir = mkdtempSync(join(tmpdir(), `zswarm-vp-${tag}-`));
  const file = join(dir, 'page.html');
  const page = `<!doctype html><html><head><meta charset="utf-8">${THEME_FALLBACK}</head><body>${fragmentHtml}</body></html>`;
  writeFileSync(file, page, 'utf8');
  return { url: pathToFileURL(file).href, dir };
}

/* ---------- 主入口：default export ---------- */
async function createProbe() {
  const chrome = findChrome();
  if (!chrome) return null;

  // playwright-core 惰性探测：优先 test/node_modules 与 ZCODE_SWARM_PW_ROOT
  let pw = null;
  const pwRoots = [
    process.env.ZCODE_SWARM_PW_ROOT,
    join(tmpdir(), 'zr-verify'),
  ].filter(Boolean);
  for (const root of pwRoots) {
    const manifest = join(root, 'node_modules', 'playwright-core', 'package.json');
    if (existsSync(manifest)) {
      try {
        const mod = await import(pathToFileURL(join(root, 'node_modules', 'playwright-core', 'index.mjs')).href);
        pw = { mod, root };
        break;
      } catch { /* 下一个候选 */ }
    }
  }

  if (pw) {
    const browser = await pw.mod.chromium.launch({ headless: true, executablePath: chrome });
    const pages = [];
    return {
      level: 'playwright',
      async open(fragmentHtml, tag = 'probe') {
        const { url, dir } = standaloneUrl(fragmentHtml, tag);
        const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForTimeout(1200);
        pages.push({ page, dir });
        return {
          page,
          errors,
          async eval(fn) { return page.evaluate(fn); },
          async clickFirst(selector) { const el = await page.$(selector); if (el) { await el.click(); await page.waitForTimeout(400); } return Boolean(el); },
          async cleanup() { rmSync(dir, { recursive: true, force: true }); },
        };
      },
      async done() { await browser.close(); },
    };
  }

  // 兜底级：只有 Chrome，静态 DOM 断言（无点击/无 pageerror）
  const opened = [];
  return {
    level: 'dump-dom',
    async open(fragmentHtml, tag = 'probe') {
      const { url, dir } = standaloneUrl(fragmentHtml, tag);
      const dom = dumpDom(chrome, url);
      opened.push(dir);
      return {
        dom,
        errors: null, // dump-dom 收不到 pageerror
        async eval() { throw new Error('dump-dom 级别不支持 evaluate，请断言 dom 字符串'); },
        async cleanup() { rmSync(dir, { recursive: true, force: true }); },
      };
    },
    async done() { opened.forEach((d) => rmSync(d, { recursive: true, force: true })); },
  };
}

export default createProbe;
