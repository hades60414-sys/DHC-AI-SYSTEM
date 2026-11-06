"""ASTRA-010：從「實際 image」產生 SBOM（CycloneDX 1.5 JSON），並與 image 內 inventory 交叉核對（缺漏必須為 0）。

用法：python3 -B scripts/enterprise/rcfix/image_sbom.py <image-ref> <輸出目錄>
步驟：
1. docker image inspect → image ID、RepoDigests、labels（source revision、profile）、架構。
2. 在 image 內（network none、唯讀、只跑 node）走訪 /app/node_modules 每個 package.json（含巢狀 node_modules），記錄 名稱／版本／安裝路徑／license 欄位／是否有 LICENSE 檔。
3. 在 image 內 dpkg-query 取得 OS 套件（名稱、版本、架構、來源套件）。
4. 產生 CycloneDX：每個「安裝位置」一個 component（bom-ref＝路徑），同名同版不同位置分開列（說明重複版本）。
5. 驗證：SBOM npm components 的 (名稱,版本,路徑) 集合 ＝ inventory 集合；OS 套件同理；差異寫入 RECONCILIATION.json，任何缺漏 exit 1。
6. V4（Astra V3 意見）：走訪不再吞錯——無法讀取的目錄或無法解析的 package.json 都記為 walk_errors 並 exit 1；
   另以 image 內 `find`（與 Node 走訪不同的枚舉器）獨立列出所有「node_modules/<名稱>/package.json」安裝位置，與走訪結果比對，
   任一邊多或少都 exit 1（避免同一枚舉器漏掃時兩邊一起消失）。OS 套件另以 /var/lib/dpkg/status 原始檔獨立解析比對。
"""
import datetime
import json
import subprocess
import sys
from pathlib import Path

NODE_WALK = r"""
const fs=require('fs'),path=require('path');
const out=[],errors=[];
function walk(dir){
  let names=[];try{names=fs.readdirSync(dir)}catch(e){if(e.code!=='ENOENT')errors.push({dir:path.relative('/app',dir),code:e.code||'READDIR'});return}
  for(const name of names){
    if(name.startsWith('.'))continue;
    const full=path.join(dir,name);
    if(name.startsWith('@')){walk(full);continue}
    const pj=path.join(full,'package.json');
    if(fs.existsSync(pj)){
      try{const p=JSON.parse(fs.readFileSync(pj,'utf8'));
        const files=fs.readdirSync(full);
        out.push({name:p.name||name,version:p.version||'',path:path.relative('/app',full),license:typeof p.license==='string'?p.license:(p.license&&p.license.type)||(Array.isArray(p.licenses)?p.licenses.map(l=>l.type||l).join(' OR '):''),
          has_license_file:files.some(f=>/^(licen[cs]e|copying|notice)/i.test(f))});
      }catch(e){errors.push({dir:path.relative('/app',full),code:'PACKAGE_JSON_UNREADABLE'})}
    }
    walk(path.join(full,'node_modules'));
  }
}
walk('/app/node_modules');
process.stdout.write(JSON.stringify({packages:out,errors}));
"""


# 與 scripts/release/enterprise-image-guard.mjs 相同的精確規則（@openai/codex-sdk 是執行期依賴，刻意保留）
EXCLUDED = ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk-*', '@openai/codex', '@openai/codex-darwin-*', '@openai/codex-linux-*',
            '@openai/codex-win32-*', '@nut-tree-fork/*', 'jimp', '@jimp/*', 'screenshot-desktop', '@napi-rs/canvas', '@napi-rs/canvas-*']


def excluded(name):
    return any(name.startswith(rule[:-1]) if rule.endswith('*') else name == rule for rule in EXCLUDED)


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f'docker {args[0]} failed: {result.stderr.strip()[:300]}')
    return result.stdout


def main():
    image, out = sys.argv[1], Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=False)
    meta = json.loads(docker('image', 'inspect', image))[0]
    run = ['run', '--rm', '--network', 'none', '--read-only', '--user', 'node', '--entrypoint']
    walked = json.loads(docker(*run, 'node', image, '-e', NODE_WALK))
    npm, walk_errors = walked['packages'], walked['errors']
    # 獨立枚舉器 1：find 列出全部 package.json，只保留「node_modules/(@scope/)?name/package.json」形式的安裝位置
    import re
    found = docker(*run, 'find', image, '/app/node_modules', '-name', 'package.json', '-type', 'f').strip().splitlines()
    install = re.compile(r'^/app/(?:node_modules/(?:@[^/]+/)?[^/.@][^/]*/)*node_modules/(?:@[^/]+/)?[^/.@][^/]*/package\.json$')
    find_paths = {line[len('/app/'):-len('/package.json')] for line in found if install.match(line)}
    walk_paths = {item['path'] for item in npm}
    # 獨立枚舉器 2：直接解析 dpkg status 原始檔（不經 dpkg-query）
    status = docker(*run, 'cat', image, '/var/lib/dpkg/status')
    dpkg_status = set()
    for stanza in status.split('\n\n'):
        fields = dict(line.split(': ', 1) for line in stanza.splitlines() if ': ' in line and not line.startswith(' '))
        if fields.get('Status', '').endswith(' installed') and fields.get('Package'):
            dpkg_status.add((fields['Package'], fields.get('Version', '')))
    dpkg = [dict(zip(['name', 'version', 'arch', 'source'], line.split('\t'))) for line in
            docker(*run, 'dpkg-query', image, '-W', '-f', '${Package}\t${Version}\t${Architecture}\t${source:Package}\n').strip().splitlines()]
    inventory = {'npm': npm, 'os': dpkg}
    (out / 'INVENTORY.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=1) + '\n')
    components = []
    for item in npm:
        component = {'type': 'library', 'bom-ref': f"npm:{item['path']}", 'name': item['name'], 'version': item['version'],
                     'purl': f"pkg:npm/{item['name'].replace('@', '%40', 1) if item['name'].startswith('@') else item['name']}@{item['version']}",
                     'properties': [{'name': 'dhc:install_path', 'value': item['path']}, {'name': 'dhc:has_license_file', 'value': str(item['has_license_file']).lower()}]}
        if item['license']:
            component['licenses'] = [{'expression': item['license']}]
        components.append(component)
    for item in dpkg:
        components.append({'type': 'library', 'bom-ref': f"deb:{item['name']}:{item['arch']}", 'name': item['name'], 'version': item['version'],
                           'purl': f"pkg:deb/debian/{item['name']}@{item['version']}?arch={item['arch']}",
                           'properties': [{'name': 'dhc:source_package', 'value': item.get('source') or item['name']}]})
    labels = meta.get('Config', {}).get('Labels') or {}
    bom = {'bomFormat': 'CycloneDX', 'specVersion': '1.5', 'version': 1,
           'metadata': {'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        'component': {'type': 'container', 'name': image, 'version': meta['Id'], 'bom-ref': f"image:{meta['Id']}",
                                      'properties': [{'name': 'oci:revision', 'value': labels.get('org.opencontainers.image.revision', '')},
                                                     {'name': 'dhc:image_profile', 'value': labels.get('com.dhc.image.profile', '')},
                                                     {'name': 'oci:architecture', 'value': meta.get('Architecture', '')},
                                                     {'name': 'oci:repo_digests', 'value': ','.join(meta.get('RepoDigests') or [])}]},
                        'tools': [{'name': 'scripts/enterprise/rcfix/image_sbom.py'}]},
           'components': components}
    (out / 'sbom.cdx.json').write_text(json.dumps(bom, ensure_ascii=False, indent=1) + '\n')
    sbom_npm = {(c['name'], c['version'], c['bom-ref'][4:]) for c in components if c['bom-ref'].startswith('npm:')}
    inv_npm = {(i['name'], i['version'], i['path']) for i in npm}
    sbom_os = {(c['name'], c['version']) for c in components if c['bom-ref'].startswith('deb:')}
    inv_os = {(i['name'], i['version']) for i in dpkg}
    unique = {(i['name'], i['version']) for i in npm}
    report = {'image_id': meta['Id'], 'profile': labels.get('com.dhc.image.profile'), 'source_revision': labels.get('org.opencontainers.image.revision'),
              'npm_install_locations': len(npm), 'npm_unique_name_version': len(unique), 'npm_duplicate_locations': len(npm) - len(unique),
              'os_packages': len(dpkg), 'sbom_components': len(components),
              'npm_missing_from_sbom': sorted(inv_npm - sbom_npm)[:50], 'npm_extra_in_sbom': sorted(sbom_npm - inv_npm)[:50],
              'os_missing_from_sbom': sorted(inv_os - sbom_os)[:50], 'os_extra_in_sbom': sorted(sbom_os - inv_os)[:50],
              'npm_without_license_field': sorted({f"{i['name']}@{i['version']}" for i in npm if not i['license']})[:100],
              'npm_without_license_file': len([i for i in npm if not i['has_license_file']]),
              'excluded_present': sorted({i['name'] for i in npm if excluded(i['name'])}),
              'walk_errors': walk_errors[:50],
              'independent_find_install_locations': len(find_paths),
              'npm_found_by_find_not_walk': sorted(find_paths - walk_paths)[:50], 'npm_walked_not_found_by_find': sorted(walk_paths - find_paths)[:50],
              'independent_dpkg_status_packages': len(dpkg_status),
              'os_status_not_in_query': sorted(dpkg_status - inv_os)[:50], 'os_query_not_in_status': sorted(inv_os - dpkg_status)[:50]}
    (out / 'RECONCILIATION.json').write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({k: v for k, v in report.items() if not isinstance(v, list) or k == 'excluded_present'}, ensure_ascii=False))
    gaps = any(report[key] for key in ['npm_missing_from_sbom', 'npm_extra_in_sbom', 'os_missing_from_sbom', 'os_extra_in_sbom', 'excluded_present', 'walk_errors',
                                        'npm_found_by_find_not_walk', 'npm_walked_not_found_by_find', 'os_status_not_in_query', 'os_query_not_in_status'])
    return 1 if gaps else 0


if __name__ == '__main__':
    raise SystemExit(main())
