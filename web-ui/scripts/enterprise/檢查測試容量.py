"""唯讀 QA 容量 preflight；保守預算不代表測得的 build 峰值或成功保證。"""
import argparse
import json
from pathlib import Path
import shutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage',choices=['before-vm','running-vm'],required=True)
    parser.add_argument('--path',type=Path,default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    # 前輪約10GB QA磁碟占用；預留2GiB，不藉啟動測試耗盡宿主機。
    required = (12 if args.stage == 'before-vm' else 2)*1024**3
    try:
        free = shutil.disk_usage(args.path).free
    except OSError:
        print(json.dumps({'status':'BLOCKED_ENVIRONMENT','stage':args.stage,'error':'DISK_USAGE_UNAVAILABLE'}))
        return 2
    shortfall = max(0,required-free)
    print(json.dumps({'status':'PENDING_ENV' if shortfall else 'CAPACITY_OK','stage':args.stage,
                      'free_bytes':free,'required_bytes':required,'shortfall_bytes':shortfall,
                      'budget_kind':'conservative_policy_not_measured_peak','mutations':'NONE'}))
    return 3 if shortfall else 0


if __name__ == '__main__':
    raise SystemExit(main())
