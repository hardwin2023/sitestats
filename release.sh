#!/usr/bin/env bash
# 发版：从 package.json 读版本号，打 git tag 并推送（用 python3 读，不依赖 node）
set -euo pipefail
cd "$(dirname "$0")"
V="$(python3 -c "import json;print(json.load(open('package.json'))['version'])")"
TAG="v${V}"
if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "!! 标签 ${TAG} 已存在。重发请先：git tag -d ${TAG} && git push origin :refs/tags/${TAG}"
  exit 1
fi
git tag -a "${TAG}" -m "release: ${TAG}"
git push origin "${TAG}"
echo "==> 已发布 ${TAG}。去 GitHub 基于该 tag 创建 Release（写几句更新说明）即可。"