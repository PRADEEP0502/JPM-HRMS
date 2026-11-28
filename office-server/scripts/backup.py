"""JPM HRMS - database backup (read-only on the database).

Copies every collection of the jpm_hrms MongoDB database into
C:\\JPM-HRMS-PY\\backups\\jpm_hrms_YYYY-MM-DD_HHMM.zip (one .jsonl file per collection,
MongoDB Extended JSON, so it can be imported again with mongoimport or a script).
Keeps the newest 14 backup files and removes older ones (only files this script made).
"""
import sys
import zipfile
from datetime import datetime
from pathlib import Path

from bson import json_util
from pymongo import MongoClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve_settings import ROOT, load_settings  # noqa: E402

KEEP = 14
BACKUPS = ROOT / 'backups'
LOG = ROOT / 'logs' / 'backup.log'


def note(message):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {message}"
    print(line)
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open('a', encoding='utf-8') as fh:
        fh.write(line + '\n')


def main():
    settings = load_settings(ROOT / 'settings.env')
    uri = settings.get('MONGO_URI')
    if not uri:
        note('FAILED: MONGO_URI is empty in settings.env')
        return 2
    BACKUPS.mkdir(exist_ok=True)
    stamp = datetime.now().strftime('%Y-%m-%d_%H%M')
    final = BACKUPS / f'jpm_hrms_{stamp}.zip'
    temp = final.with_suffix('.zip.part')
    client = MongoClient(uri, serverSelectionTimeoutMS=20000)
    db = client['jpm_hrms']
    names = sorted(db.list_collection_names())  # connects first: no file is made if this fails
    if not names:
        raise RuntimeError('the database has no collections')
    total = 0
    try:
        with zipfile.ZipFile(temp, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
            for name in names:
                count = 0
                with zf.open(f'{name}.jsonl', 'w') as out:
                    for doc in db[name].find():
                        out.write((json_util.dumps(doc, json_options=json_util.CANONICAL_JSON_OPTIONS) + '\n').encode('utf-8'))
                        count += 1
                note(f'  {name}: {count} documents')
                total += count
        temp.replace(final)
    finally:
        if temp.exists():
            temp.unlink()  # half-written file from a failed run
    note(f'OK: {total} documents in {len(names)} collections -> {final} ({final.stat().st_size // 1024} KB)')
    old = sorted(BACKUPS.glob('jpm_hrms_*.zip'))[:-KEEP]
    for path in old:
        path.unlink()
        note(f'  removed old backup {path.name}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:  # message only, never the connection string
        note(f'FAILED: {type(error).__name__}: {error}')
        sys.exit(1)
