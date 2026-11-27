#!/bin/bash
# Invoked by prepareMacUpdate with the updater lock on fd 4 and a private handoff pipe on fd 3.
set -u
umask 077
application=$1 stage=$2 directory=$3 parent_pid=$4 original=$5 version=$6 executable=$7
mode=$8 wait_seconds=$9 failure_file=${10}
shift 10
candidate="$stage/Candidate.app"
receipt="$stage/ready"
log="$directory/mac-install.log"
exec >>"$log" 2>&1 || exit 1

identity() { /usr/bin/stat -f '%d:%i' "$1"; }
report_failure() {
  echo "$1"
  if [[ -n "$failure_file" ]]; then
    local temporary
    temporary=$(/usr/bin/mktemp "$failure_file.XXXXXX") || return
    /usr/bin/printf '%s\n' "$1" >"$temporary" && /bin/mv -f "$temporary" "$failure_file"
  fi
}
# ps comm includes the path to the executable (not the user's arguments). Include independent launchers,
# Electron helpers and bundled ccdt processes. Filenames with spaces remain one field after stripping the PID.
processes() {
  /bin/ps -axww -o pid= -o comm= | CCDT_APP_PREFIX="$application/Contents/" /usr/bin/awk '
    { pid=$1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, ""); if (index($0, ENVIRON["CCDT_APP_PREFIX"]) == 1) print pid }
  '
}
wait_for_exit() {
  local remaining="$wait_seconds"
  while [[ -n "$(processes)" ]] || kill -0 "$parent_pid" 2>/dev/null; do
    (( remaining > 0 )) || return 1
    /bin/sleep 1
    ((remaining--))
  done
}
# Darwin's RENAME_SWAP exchanges two complete directories in one filesystem operation. Both reside in
# the same installation directory; if the volume does not support this operation, neither path changes.
swap_apps() {
  /usr/bin/osascript -l JavaScript -e '
    ObjC.import("Foundation");
    ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]);
    function run(paths) {
      if ($.renamex_np(paths[0], paths[1], 2) !== 0) throw Error("Could not exchange application bundles.");
    }' "$application" "$candidate"
}
open_old() { /usr/bin/open -n -a "$application" --args "$@"; }
# Readiness for releases predating our renderer receipt. Only count the actual app executable in this
# installation and require that Launch Services saw the same responsive process for five seconds.
main_pids() {
  /bin/ps -axww -o pid= -o comm= | CCDT_APP_EXECUTABLE="$application/Contents/MacOS/$executable" /usr/bin/awk '
    { pid=$1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, ""); if ($0 == ENVIRON["CCDT_APP_EXECUTABLE"]) print pid }
  '
}
healthy_pid() {
  local pid
  for pid in $(main_pids); do
    if /usr/bin/lsappinfo info -only isready -app "$pid" | /usr/bin/grep -Fqx '"LSApplicationHasSignalledItIsReady"=true'; then
      echo "$pid"
      return 0
    fi
  done
  return 1
}
wait_for_ready() {
  local remaining="$wait_seconds" last='' stable=0 now
  while (( remaining > 0 )); do
    if [[ "$mode" == receipt ]]; then
      if [[ -f "$receipt" && ! -L "$receipt" && "$(cat "$receipt")" == "$version" && -n "$(main_pids)" ]]; then
        return 0
      fi
    else
      now=$(healthy_pid) || now=''
      if [[ -n "$now" && "$now" == "$last" ]]; then ((stable++)); else stable=0; fi
      (( stable >= 5 )) && return 0
      last=$now
    fi
    /bin/sleep 1
    ((remaining--))
  done
  return 1
}
# Request a normal quit only from the just-launched application's main process at this path. A running
# app that declines to quit keeps its code in place, and the complete old bundle remains in staging.
quit_candidate() {
  /usr/bin/osascript -l JavaScript -e '
    ObjC.import("AppKit");
    function run(paths) {
      const items = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("io.github.ccdesktunnel.desktop");
      for (let i = 0; i < items.count; ++i) {
        const app = items.objectAtIndex(i);
        if (ObjC.unwrap(app.bundleURL.URLByResolvingSymlinksInPath.path) === paths[0]) app.terminate;
      }
    }' "$application"
}
[[ -d "$candidate" && -d "$application" && "$(identity "$application")" == "$original" ]] || exit 1
replacement=$(identity "$candidate") || exit 1
still_ours() {
  [[ "$(identity "$application")" == "$replacement" && "$(identity "$candidate")" == "$original" ]]
}
/usr/bin/printf 'ready\n' >&3 || exit 1
exec 3>&-
if ! wait_for_exit; then
  report_failure "A process is still using the installed application. Quit its windows and bundled terminal sessions before trying again."
  /bin/rm -rf "$stage"
  if ! kill -0 "$parent_pid" 2>/dev/null && [[ "$(identity "$application")" == "$original" ]]; then open_old "$@"; fi
  exit 1
fi
if [[ "$(identity "$application")" != "$original" ]] || ! swap_apps; then
  report_failure "The installed application changed or the volume could not exchange the bundles. The update was not applied."
  /bin/rm -rf "$stage"
  if [[ "$(identity "$application")" == "$original" ]]; then open_old "$@"; fi
  exit 1
fi
if /usr/bin/open -n -a "$application" --args "$@" "--ccdt-update-receipt=$receipt" && wait_for_ready && still_ours; then
  if [[ "$mode" == launchservices ]]; then
    if ! /bin/mv "$candidate" "$directory/Previous.app"; then
      echo "Startup confirmed by Launch Services. Previous application retained at $candidate."
      exit 0
    fi
    echo "Startup confirmed by Launch Services. Previous application retained at $directory/Previous.app."
  else
    echo "Renderer acknowledged $version."
  fi
  /bin/rm -rf "$stage"
  exit 0
fi

if still_ours && [[ -n "$(main_pids)" ]]; then quit_candidate; fi
if still_ours && wait_for_exit && still_ours && swap_apps; then
  report_failure "The new application could not start. The previous version has been restored."
  /bin/rm -rf "$stage"
  open_old "$@"
else
  report_failure "The new application could not confirm startup or be replaced. Its previous version is preserved at $candidate."
fi
exit 1
