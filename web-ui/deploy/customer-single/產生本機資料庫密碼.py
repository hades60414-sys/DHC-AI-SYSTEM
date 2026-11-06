"""產生本機獨立 DB 帳號 env_file；不輸出密碼、不覆寫既有檔案。"""
import argparse
import json
import os
from pathlib import Path
import secrets
import stat

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--directory', type=Path, default=Path(__file__).parent / '.secrets')
args = parser.parse_args()
directory = args.directory
if directory.is_symlink():
    raise SystemExit('拒絕使用 symlink 密碼目錄')
directory.mkdir(parents=True, mode=0o700, exist_ok=True)
if directory.stat().st_mode & 0o077:
    raise SystemExit('密碼目錄必須為 0700')
names = ['bootstrap.env', 'app.env', 'migrate.env']
existing = [name for name in names if (directory / name).exists() or (directory / name).is_symlink()]
if existing:
    if len(existing) != len(names):
        raise SystemExit('密碼檔不完整；拒絕重新生成，請先由操作員確認狀態')
    for name in names:
        info = (directory / name).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise SystemExit('既有密碼檔必須是本使用者的 0600 普通檔案')
    print(json.dumps({'generated': False, 'files': names}))
else:
    owner, app, migrator = [secrets.token_hex(32) for _ in range(3)]
    contents = {
        'bootstrap.env': f'POSTGRES_PASSWORD={owner}\nENTERPRISE_APP_PASSWORD={app}\nENTERPRISE_MIGRATOR_PASSWORD={migrator}\n',
        'app.env': f'ENTERPRISE_DB_PASSWORD={app}\n',
        'migrate.env': f'ENTERPRISE_DB_PASSWORD={migrator}\n',
    }
    for name, content in contents.items():
        descriptor = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(content)
    print(json.dumps({'generated': True, 'files': names}))
