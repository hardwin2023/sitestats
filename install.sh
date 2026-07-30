#!/usr/bin/env bash
# SiteStats 远程一键安装引导脚本（自包含，无需先下载仓库、无需装 git）
#
#   交互安装：   curl -fsSL https://raw.githubusercontent.com/hardwin2023/sitestats/main/install.sh | bash
#   无人值守：   curl -fsSL https://raw.githubusercontent.com/hardwin2023/sitestats/main/install.sh | sudo bash -s -- --yes --pm2
#   指定版本：   curl -fsSL .../install.sh | sudo env SITESTATS_VERSION=v1.0.0 bash
#   自定义目录： curl -fsSL .../install.sh | env SITESTATS_DIR=$HOME/.sitestats bash
set -euo pipefail

REPO="https://github.com/hardwin2023/sitestats"
VERSION="${SITESTATS_VERSION:-main}"
INSTALL_DIR="${SITESTATS_DIR:-/opt/sitestats}"

echo "==> SiteStats 远程安装（版本: ${VERSION} → ${INSTALL_DIR}）"

# 装到系统目录需要 root
if [ "${INSTALL_DIR}" = "/opt/sitestats" ] && [ "$(id -u)" -ne 0 ]; then
  echo "!! 安装到 ${INSTALL_DIR} 需要 root 权限，请改用："
  echo "   curl -fsSL <本脚本地址> | sudo bash -s -- $*"
  echo "   或：curl -fsSL <本脚本地址> | env SITESTATS_DIR=\$HOME/.sitestats bash"
  exit 1
fi

# 依赖检查
command -v python3 >/dev/null 2>&1 || { echo "!! 需要 python3"; exit 1; }
command -v curl    >/dev/null 2>&1 || { echo "!! 需要 curl"; exit 1; }
command -v node    >/dev/null 2>&1 || echo "!! 警告：未检测到 node，请稍后自行安装 Node ≥16"

# 下载仓库 tarball（不依赖 git）
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
if [ "${VERSION}" = "main" ] || [ "${VERSION}" = "master" ]; then
  URL="${REPO}/archive/refs/heads/${VERSION}.tar.gz"
else
  URL="${REPO}/archive/refs/tags/${VERSION}.tar.gz"
fi
echo "==> 下载 ${URL}"
curl -fsSL "${URL}" -o "${TMP}/ss.tar.gz"
tar xzf "${TMP}/ss.tar.gz" -C "${TMP}"
SRC="$(find "${TMP}" -maxdepth 1 -type d -name 'sitestats-*' | head -1)"
[ -n "${SRC}" ] || { echo "!! 解压失败"; exit 1; }

# 部署到目标目录
mkdir -p "${INSTALL_DIR}"
cp -R "${SRC}"/. "${INSTALL_DIR}"/
echo "==> 已部署到 ${INSTALL_DIR}，交给智能安装器…"
cd "${INSTALL_DIR}"

# 关键：curl|bash 时 stdin 是管道，install.py 的交互输入须走真实终端 /dev/tty；
# 无终端环境（如 CI）则自动非交互 --yes
if [ -e /dev/tty ]; then
  exec python3 install.py "$@" < /dev/tty
else
  exec python3 install.py --yes "$@"
fi