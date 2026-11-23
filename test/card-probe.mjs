// 无头浏览器里渲染会话内卡片片段（宿主 visualize.css + window.zcode 桩），打印探针行供 run.mjs 断言。
// 用法：node test/card-probe.mjs <fragment.html> <settings|review>
// 找不到 Chrome/Edge 时退出码 3（SKIP）。
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [fragmentPath, mode] = process.argv.slice(2);
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const chrome = CHROME_CANDIDATES.find(existsSync);
if (!chrome) {
  console.log('SKIP card-probe: 找不到 Chrome/Edge（设 env CHROME_PATH）');
  process.exit(3);
}
const CSS_CANDIDATES = [
  process.env.ZCODE_WINDOWS_APP_INSTALL_DIR && `${process.env.ZCODE_WINDOWS_APP_INSTALL_DIR}/resources/glm/packages/bundled-skills/../visualize`,
  'C:/Users/AA/.zcode/cli/plugins/cache/zcode-plugins-official/visualize/0.1.1/skills/visualize/assets/visualize.css',
].filter(Boolean);
const css = CSS_CANDIDATES.find((p) => p.endsWith('.css') && existsSync(p)) ?? CSS_CANDIDATES.find(existsSync);

const probe =
  mode === 'review'
    ? `
var root = document.getElementById('zcode-swarm-lineup');
var rows = Array.prototype.map.call(root.querySelectorAll('[data-role]'), function (b) {
  var sel = b.querySelector('select[data-pick]');
  return b.getAttribute('data-role') + ' = ' + sel.value + ' | changed=' + !b.querySelector('[data-changed]').hidden;
});
out.push('ROLES ' + rows.length);
rows.forEach(function (r) { out.push(r); });
out.push('CARDCLASS ' + root.className);
out.push('SUMMARY ' + root.querySelector('#zl-summary').textContent);
var sel = root.querySelector('select[data-pick="card:1"]');
if (sel) { sel.value = sel.querySelector('option[value^="model:"]') ? sel.querySelector('option[value^="model:"]').value : sel.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
finish();
`
    : `
var root = document.getElementById('zcode-swarm-settings');
var rows = Array.prototype.map.call(root.querySelectorAll('select[data-key]'), function (s) {
  var key = s.getAttribute('data-key');
  var custom = root.querySelector('input[data-custom="' + key + '"]');
  return key + ' = ' + s.value + (custom && !custom.hidden ? ' | custom=' + custom.value : '');
});
rows.forEach(function (r) { out.push(r); });
out.push('MIGRATED ' + (root.querySelector('#zs-migrated').hidden ? 'hidden' : root.querySelector('#zs-migrated').textContent));
out.push('CARDCLASS ' + root.className);
var cap = null;
window.zcode.sendFollowUpMessage = function (m) { cap = m; return Promise.resolve(); };
root.querySelector('#zs-save').click();
setTimeout(function () {
  if (cap) {
    var mm = /<<'JSON'\\n([\\s\\S]*?)\\nJSON/.exec(cap.prompt);
    out.push('PAYLOAD ' + (mm ? mm[1] : '(none)'));
  } else out.push('PAYLOAD (no send)');
  finish();
}, 60);
`;

const page = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="icon" href="data:,">
${css ? `<link rel="stylesheet" href="file:///${css.replace(/\\/g, '/')}">` : ''}
<style>body{margin:0;padding:16px}</style></head><body>
<script>window.zcode={widgetState:null,sendFollowUpMessage:function(){return Promise.resolve();},setWidgetState:function(){return Promise.resolve();}};</script>
${readFileSync(fragmentPath, 'utf8')}
<script>
window.addEventListener('load', function () {
  var out = [];
  function finish() {
    var pre = document.createElement('pre'); pre.id = 'probe'; pre.textContent = out.join('\\n'); document.body.appendChild(pre);
  }
  ${probe}
});
</script></body></html>`;
const pagePath = join(tmpdir(), `swarm-card-probe-${process.pid}.html`);
writeFileSync(pagePath, page, 'utf8');
const dom = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--virtual-time-budget=4000', '--dump-dom', `file:///${pagePath.replace(/\\/g, '/')}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
const m = /<pre id="probe">([\s\S]*?)<\/pre>/.exec(dom);
if (!m) {
  console.error('card-probe: 探针没出现（片段脚本出错？）');
  process.exit(1);
}
console.log(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
