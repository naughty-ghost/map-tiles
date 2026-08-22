#!/usr/bin/env bash
# GitHub リポジトリのラベルを .github/labels.json に従って同期する。
#
# 動作:
#   - 定義ファイルにあるラベルを作成、または既存ラベルを更新する
#   - 定義ファイルに無いラベルは削除しない（安全側）
#
# 使い方:
#   ./scripts/sync-labels.sh                    # カレントリポジトリに適用
#   ./scripts/sync-labels.sh -R owner/repo      # 任意のリポジトリに適用
#   ./scripts/sync-labels.sh --dry-run          # 実行内容のみ表示
#
# 必要コマンド: gh, jq
#   Windows での jq インストール例:
#     winget install jqlang.jq      # winget
#     choco install jq              # Chocolatey
#     scoop install jq              # Scoop

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LABELS_FILE="${REPO_ROOT}/.github/labels.json"

REPO_FLAG=()
DRY_RUN=0

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -R|--repo)
      REPO_FLAG=(--repo "$2")
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "不明な引数: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

for cmd in gh jq; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "エラー: ${cmd} が見つかりません。インストールしてください。" >&2
    exit 1
  fi
done

if [[ ! -f "${LABELS_FILE}" ]]; then
  echo "エラー: 定義ファイルが見つかりません: ${LABELS_FILE}" >&2
  exit 1
fi

if ! jq empty "${LABELS_FILE}" >/dev/null 2>&1; then
  echo "エラー: 定義ファイルが不正な JSON です: ${LABELS_FILE}" >&2
  exit 1
fi

count=$(jq 'length' "${LABELS_FILE}")
echo "定義ファイル: ${LABELS_FILE}"
echo "対象ラベル数: ${count}"
if [[ ${#REPO_FLAG[@]} -gt 0 ]]; then
  echo "対象リポジトリ: ${REPO_FLAG[1]}"
else
  echo "対象リポジトリ: (カレント)"
fi
if [[ ${DRY_RUN} -eq 1 ]]; then
  echo "モード: dry-run"
fi
echo

created=0
updated=0
failed=0

while IFS=$'\t' read -r name color description; do
  # gh label create --force は存在すれば更新、存在しなければ作成。
  # 結果メッセージから create / update を判別する。
  args=(label create "${name}" --color "${color}" --description "${description}" --force "${REPO_FLAG[@]}")

  if [[ ${DRY_RUN} -eq 1 ]]; then
    printf '[dry-run] gh %s\n' "${args[*]}"
    continue
  fi

  if output=$(gh "${args[@]}" 2>&1); then
    if [[ "${output}" == *"already exists"* || "${output}" == *"updated"* || "${output}" == *"Updated"* ]]; then
      printf '✔ updated: %s\n' "${name}"
      updated=$((updated + 1))
    else
      printf '✔ created: %s\n' "${name}"
      created=$((created + 1))
    fi
  else
    printf '✘ failed : %s -- %s\n' "${name}" "${output}" >&2
    failed=$((failed + 1))
  fi
done < <(jq -r '.[] | [.name, .color, (.description // "")] | @tsv' "${LABELS_FILE}")

echo
if [[ ${DRY_RUN} -eq 1 ]]; then
  echo "dry-run 完了。"
else
  printf '完了: created=%d updated=%d failed=%d\n' "${created}" "${updated}" "${failed}"
  if [[ ${failed} -gt 0 ]]; then
    exit 1
  fi
fi
