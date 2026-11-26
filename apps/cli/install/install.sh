#!/bin/sh
# Installs ccdt from this folder for the current user: copies it to ~/.local/share/ccdt and links
# ~/.local/bin/ccdt to it. Running it again updates ccdt in place.
set -eu
# What it says is in the system's language, Chinese or else English, as ccdt's (apps/cli/src/i18n.mjs): the locale
# the terminal sets, else on a Mac the system's.
locale=
for tag in "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
  case "$tag" in '' | C | C.* | POSIX | POSIX.*) ;; *) locale=$tag && break ;; esac
done
if [ -z "$locale" ] && [ "$(uname -s)" = Darwin ]; then locale=$(defaults read -g AppleLocale 2>/dev/null || true); fi
case "$locale" in zh* | ZH*) zh=1 ;; *) zh= ;; esac
say() { if [ -n "$zh" ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
here=$(cd "$(dirname "$0")" && pwd)
target=${XDG_DATA_HOME:-$HOME/.local/share}/ccdt
if [ "$here" != "$target" ]; then
  rm -rf "$target"
  mkdir -p "$(dirname "$target")"
  cp -R "$here" "$target"
fi
# A package a browser downloaded on a Mac carries the mark of the download, which the files unpacked from it take on;
# it would have the system ask about, or refuse, the Node and the SSH library inside.
if [ "$(uname -s)" = Darwin ]; then xattr -dr com.apple.quarantine "$target" 2>/dev/null || true; fi
mkdir -p "$HOME/.local/bin"
# A desktop client that carries ccdt has made ~/.local/bin/ccdt its own (apps/desktop/electron/ccdt.mjs): that is the
# ccdt the terminal runs, updated with the client, and it stays so.
desktop=
current=$(readlink "$HOME/.local/bin/ccdt" 2>/dev/null || true)
case "$current" in
*/resources/ccdt/bin/ccdt) if [ -e "$current" ]; then desktop=$current; fi ;;
esac
if [ -n "$desktop" ]; then
  say "ccdt 已安装到 ${target}。图形客户端自带的 ccdt（${desktop}）是 ~/.local/bin/ccdt，终端里用的是它，随图形客户端升级。" \
    "ccdt is installed in ${target}. ~/.local/bin/ccdt is the ccdt the desktop client carries (${desktop}): the terminal runs that one, and it is updated with the client."
else
  ln -sf "$target/bin/ccdt" "$HOME/.local/bin/ccdt"
  say "ccdt 已安装到 ${target}，命令为 ~/.local/bin/ccdt。" "ccdt is installed in ${target}; the command is ~/.local/bin/ccdt."
fi
# ~/.local/bin is not on the PATH everywhere, never on macOS by default: the line that puts it there goes once into
# the configuration file of the user's shell, marked as ccdt's, for every shell started from now on.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) say "运行 ccdt login 登录服务端。" "Run ccdt login to sign in to the server." ;;
  *)
    line='export PATH="$HOME/.local/bin:$PATH"'
    case "${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc" ;;
      */bash) if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
      *) rc="$HOME/.profile" ;;
    esac
    if ! grep -qsF "$line" "$rc"; then
      printf '\n# ccdt\n%s\n' "$line" >>"$rc"
      say "已把 ~/.local/bin 加入 PATH（写在 ${rc}）。" "Added ~/.local/bin to the PATH (in ${rc})."
    fi
    say "打开一个新的终端窗口后运行 ccdt login 登录服务端；在这个窗口里先运行 ${line}。" \
      "Open a new terminal window and run ccdt login to sign in to the server; in this window, run ${line} first."
    ;;
esac
