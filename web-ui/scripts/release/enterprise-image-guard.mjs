// ASTRA-012：企業 image 建置時的守門（在 Docker build stage、prune 之後執行）。
// 1. 被排除的套件不得存在於 node_modules。
// 2. dist-server 內每個「靜態」bare import 都必須能在 node_modules 找到（避免 prune／刪除誤傷執行期依賴而啟動失敗）。
//    只允許清單內的「延遲載入、個人模式專用」套件缺席（以 dynamic import 載入，企業模式不會執行）。
// 3. 輸出 dist-server/IMAGE_PROFILE.json（隨 image 出貨，供 SBOM／審查核對）。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const modules = path.join(root, 'node_modules');
// 精確套件名，或以 * 結尾的前綴
const EXCLUDED = ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk-*', '@openai/codex', '@openai/codex-darwin-*', '@openai/codex-linux-*',
  '@openai/codex-win32-*', '@nut-tree-fork/*', 'jimp', '@jimp/*', 'screenshot-desktop', '@napi-rs/canvas', '@napi-rs/canvas-*'];
const LAZY_PERSONAL_ONLY = new Set(['@anthropic-ai/claude-agent-sdk']);
const matches = (name, rule) => (rule.endsWith('*') ? name.startsWith(rule.slice(0, -1)) : name === rule);

function installed(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    if (name.startsWith('.')) return [];
    if (name.startsWith('@')) return installed(path.join(dir, name), `${name}/`);
    return [`${prefix}${name}`];
  });
}

function jsFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' || name === 'tests' ? [] : jsFiles(full);
    return /\.(m?js)$/.test(name) ? [full] : [];
  });
}

const packageOf = specifier => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);

const present = installed(modules);
const leaked = present.filter(name => EXCLUDED.some(rule => matches(name, rule)));
const missing = new Map();
for (const file of jsFiles(path.join(root, 'dist-server'))) {
  const source = readFileSync(file, 'utf8');
  const statics = [...source.matchAll(/^\s*(?:import|export)\s[^'"`]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)].map(m => m[1] ?? m[2]);
  for (const specifier of statics) {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || builtins.has(specifier) || builtins.has(packageOf(specifier))) continue;
    const name = packageOf(specifier);
    if (LAZY_PERSONAL_ONLY.has(name)) continue;
    if (!existsSync(path.join(modules, name, 'package.json'))) missing.set(name, path.relative(root, file));
  }
}
if (leaked.length || missing.size) {
  if (leaked.length) console.error(`[enterprise-image-guard] excluded packages still present: ${leaked.join(', ')}`);
  for (const [name, file] of missing) console.error(`[enterprise-image-guard] static import "${name}" (from ${file}) is not installed`);
  process.exit(1);
}
writeFileSync(path.join(root, 'dist-server', 'IMAGE_PROFILE.json'), `${JSON.stringify({ profile: 'enterprise', excluded_rules: EXCLUDED, lazy_personal_only: [...LAZY_PERSONAL_ONLY],
  installed_top_level_packages: present.length }, null, 1)}\n`);
console.log(`[enterprise-image-guard] ok: ${present.length} top-level packages, none excluded, all static imports resolvable`);
