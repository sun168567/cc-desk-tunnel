#!/bin/sh
# Installs ccdt from this folder for the current user: copies it to ~/.local/share/ccdt and links
# ~/.local/bin/ccdt to it. Running it again updates ccdt in place.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
target=${XDG_DATA_HOME:-$HOME/.local/share}/ccdt
if [ "$here" != "$target" ]; then
  rm -rf "$target"
  mkdir -p "$(dirname "$target")"
  cp -R "$here" "$target"
fi
mkdir -p "$HOME/.local/bin"
ln -sf "$target/bin/ccdt" "$HOME/.local/bin/ccdt"
echo "ccdt 已安装到 $target，命令为 ~/.local/bin/ccdt。"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "~/.local/bin 不在 PATH 里：把 export PATH=\"\$HOME/.local/bin:\$PATH\" 加入 shell 的配置文件。" ;;
esac
echo "运行 ccdt login 登录服务端。"
