#!/usr/bin/env bash
# V5.2 ASTRA-ROLL-001／008：品質閘門。分開保存「原工具退出碼」「比較器退出碼」「閘門退出碼」；
# 比較器已把原工具退出碼納入判斷（輸出沒有失敗卻非 0 結束＝失敗），閘門退出碼＝比較器退出碼，不經 tee 遮蔽。
# 用法：gate.sh <backend|frontend|lint> <工具輸出檔> <證據前綴> -- <工具指令…>
set -u -o pipefail
kind=$1 input=$2 prefix=$3
shift 3
[ "${1:-}" = "--" ] && shift
"$@"
tool=$?
compare_out=$(python3 -B "$(dirname "$0")/compare_known_failures.py" "$kind" "$input" --runner-exit "$tool")
cmp=$?
printf '%s\n' "$compare_out" > "$prefix-compare.json"
printf '%s\n' "$compare_out"
printf '{"kind":"%s","tool_exit":%d,"comparator_exit":%d,"gate_exit":%d}\n' "$kind" "$tool" "$cmp" "$cmp" > "$prefix-exit.json"
echo "gate $kind: tool_exit=$tool comparator_exit=$cmp" >&2
exit "$cmp"
