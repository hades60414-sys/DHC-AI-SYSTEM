"""產生 AI Office 單客戶 env_file（DB 帳號密碼、BYOK 主金鑰）。不輸出秘密、不覆寫既有檔案、只接受 0700 目錄。"""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--directory', type=Path, required=True)
parser.add_argument('--reuse-secret-key-from', type=Path, help='還原時沿用舊安裝 app.env 中的 ENTERPRISE_SECRET_KEY（BYOK 才能解密）')
args = parser.parse_args()
directory = args.directory
if directory.is_symlink():
    raise SystemExit('拒絕使用 symlink 密碼目錄')
directory.mkdir(parents=True, mode=0o700, exist_ok=True)
if directory.stat().st_mode & 0o077:
    raise SystemExit('密碼目錄必須為 0700')
names = ['bootstrap.env', 'app.env', 'migrate.env']
if any((directory / name).exists() for name in names):
    raise SystemExit('密碼檔已存在；拒絕覆寫（遺失 ENTERPRISE_SECRET_KEY 會使已加密的 BYOK 金鑰無法解密）')
owner, app, migrator = [secrets.token_hex(32) for _ in range(3)]
secret_key = base64.b64encode(secrets.token_bytes(32)).decode()
if args.reuse_secret_key_from:
    values = dict(line.split('=', 1) for line in args.reuse_secret_key_from.read_text().splitlines() if '=' in line)
    secret_key = values.get('ENTERPRISE_SECRET_KEY', '')
    if len(base64.b64decode(secret_key or 'x===', validate=False)) != 32:
        raise SystemExit('舊 app.env 沒有有效的 ENTERPRISE_SECRET_KEY')
contents = {
    'bootstrap.env': f'POSTGRES_PASSWORD={owner}\nENTERPRISE_APP_PASSWORD={app}\nENTERPRISE_MIGRATOR_PASSWORD={migrator}\n',
    'app.env': f'ENTERPRISE_DB_PASSWORD={app}\nENTERPRISE_SECRET_KEY={secret_key}\n',
    'migrate.env': f'ENTERPRISE_DB_PASSWORD={migrator}\n',
}
for name, content in contents.items():
    descriptor = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(content)
print(json.dumps({'generated': True, 'files': names}))
