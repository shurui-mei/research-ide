#!/bin/sh
set -eu

INSTALL_ID='org.researchide.desktop'
EXECUTE=0
KEEP_INSTALLATION=0
KEEP_DATA=0
KEEP_STATE=0
DELETE_PROJECTS=0
GRAPHICAL_AUTH=0
INSTALL_DIR=''
DATA_DIR=''
STATE_DIR=''
PROJECTS=''
CONFIRMED_PROJECTS=''

usage() {
  cat <<'EOF'
Usage: uninstall-research-ide.sh [options]

The default is a dry run. Research projects are always preserved unless both
--delete-projects and an exact --confirm-project PATH (or interactive exact
path entry) are supplied for every project.

  --execute                 perform the validated removal plan
  --graphical-auth          use PolicyKit for the system package step
  --install-dir PATH        Research IDE installation/app bundle to remove
  --data-dir PATH           marked Research IDE application-data directory
  --state-dir PATH          marked Research IDE launcher-state directory
  --keep-installation       preserve the application installation
  --keep-data               preserve application data
  --keep-state              preserve launcher diagnostic state
  --project PATH            optional project candidate (repeatable)
  --delete-projects         opt in to deleting project candidates
  --confirm-project PATH    exact project path confirmation (repeatable)
  --help                    show this help
EOF
}

fail() { printf 'Research IDE uninstaller refused: %s\n' "$*" >&2; exit 2; }

append_line() {
  if [ -z "$1" ]; then printf '%s' "$2"; else printf '%s\n%s' "$1" "$2"; fi
}

trusted_system_command() {
  case "$1" in apt-get|dnf|rpm|pkexec) ;; *) return 1 ;; esac
  for directory in /usr/bin /bin /usr/sbin /sbin; do
    candidate=$directory/$1
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --graphical-auth) GRAPHICAL_AUTH=1 ;;
    --keep-installation) KEEP_INSTALLATION=1 ;;
    --keep-data) KEEP_DATA=1 ;;
    --keep-state) KEEP_STATE=1 ;;
    --delete-projects) DELETE_PROJECTS=1 ;;
    --install-dir|--data-dir|--state-dir|--project|--confirm-project)
      [ "$#" -ge 2 ] || fail "$1 requires a path"
      case "$2" in
        *'
'*|*'|'*) fail "$1 path contains a forbidden line break or plan delimiter" ;;
      esac
      case "$1" in
        --install-dir) INSTALL_DIR=$2 ;;
        --data-dir) DATA_DIR=$2 ;;
        --state-dir) STATE_DIR=$2 ;;
        --project) PROJECTS=$(append_line "$PROJECTS" "$2") ;;
        --confirm-project) CONFIRMED_PROJECTS=$(append_line "$CONFIRMED_PROJECTS" "$2") ;;
      esac
      shift ;;
    --help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

SYSTEM=$(uname -s)
case "$SYSTEM" in
  Linux)
    DEFAULT_INSTALL='/usr/lib/research-ide'
    DEFAULT_DATA=${XDG_CONFIG_HOME:-${HOME:?HOME is required}/.config}/'Research IDE'
    DEFAULT_STATE=${XDG_STATE_HOME:-${HOME:?HOME is required}/.local/state}/research-ide
    ;;
  Darwin)
    DEFAULT_INSTALL='/Applications/Research IDE.app'
    DEFAULT_DATA=${HOME:?HOME is required}/'Library/Application Support/Research IDE'
    DEFAULT_STATE=''
    ;;
  *) fail "unsupported platform: $SYSTEM" ;;
esac
[ -n "$INSTALL_DIR" ] || INSTALL_DIR=$DEFAULT_INSTALL
[ -n "$DATA_DIR" ] || DATA_DIR=$DEFAULT_DATA
[ -n "$STATE_DIR" ] || STATE_DIR=$DEFAULT_STATE

reject_dangerous_root() {
  candidate=$1
  [ "$candidate" != '/' ] || fail 'filesystem root is never removable'
  [ "$candidate" != "$HOME" ] || fail 'home directory is never removable'
  case "$HOME/" in "$candidate/"*) fail "ancestor of home is never removable: $candidate" ;; esac
}

canonical_directory() {
  [ -n "$1" ] || fail 'empty path'
  [ -d "$1" ] || fail "directory does not exist: $1"
  [ ! -L "$1" ] || fail "symbolic-link directory is not removable: $1"
  resolved=$(CDPATH= cd -P "$1" 2>/dev/null && pwd -P) || fail "cannot resolve directory: $1"
  reject_dangerous_root "$resolved"
  printf '%s' "$resolved"
}

directory_identity() {
  case "$SYSTEM" in
    Linux) stat -Lc '%d:%i' "$1" ;;
    Darwin) stat -Lf '%d:%i' "$1" ;;
  esac
}

remove_directory() {
  case "$SYSTEM" in
    Linux) rm -rf --one-file-system -- "$1" ;;
    Darwin) rm -rf -- "$1" ;;
  esac
}

regular_marker_inside() {
  root=$1
  marker=$2
  [ -f "$marker" ] && [ ! -L "$marker" ] || fail "required regular marker is missing: $marker"
  marker_parent=$(CDPATH= cd -P "$(dirname "$marker")" 2>/dev/null && pwd -P) || fail "cannot resolve marker: $marker"
  marker_real=$marker_parent/$(basename "$marker")
  case "$marker_real" in "$root"/*) ;; *) fail "marker escapes its candidate directory: $marker" ;; esac
}

validate_json_marker() {
  marker=$1
  kind=$2
  grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*1([,[:space:]}]|$)' "$marker" || fail "marker schema mismatch: $marker"
  grep -Eq '"installId"[[:space:]]*:[[:space:]]*"org\.researchide\.desktop"([,[:space:]}]|$)' "$marker" || fail "marker install identifier mismatch: $marker"
  grep -Eq "\"kind\"[[:space:]]*:[[:space:]]*\"$kind\"([,[:space:]}]|$)" "$marker" || fail "marker kind mismatch: $marker"
}

INSTALL_CANONICAL=''
INSTALL_SYSTEM_PACKAGE=0
if [ "$KEEP_INSTALLATION" -eq 0 ]; then
  INSTALL_CANONICAL=$(canonical_directory "$INSTALL_DIR")
  case "$SYSTEM:$INSTALL_CANONICAL" in
    Linux:/usr/lib/research-ide)
      INSTALL_MARKER=$INSTALL_CANONICAL/resources/distribution/install-manifest.json
      INSTALL_EXECUTABLE=$INSTALL_CANONICAL/research-ide
      INSTALL_SYSTEM_PACKAGE=1
      ;;
    Darwin:*.app)
      [ "$(basename "$INSTALL_CANONICAL")" = 'Research IDE.app' ] || fail 'macOS app bundle name is not Research IDE.app'
      INSTALL_MARKER=$INSTALL_CANONICAL/Contents/Resources/distribution/install-manifest.json
      INSTALL_EXECUTABLE=$INSTALL_CANONICAL/Contents/MacOS/research-ide
      ;;
    Linux:*)
      case "$(basename "$INSTALL_CANONICAL")" in research-ide|'Research IDE-linux-'*) ;; *) fail 'custom Linux installation name is not recognized' ;; esac
      INSTALL_MARKER=$INSTALL_CANONICAL/resources/distribution/install-manifest.json
      INSTALL_EXECUTABLE=$INSTALL_CANONICAL/research-ide
      ;;
    *) fail 'installation layout does not match this platform' ;;
  esac
  regular_marker_inside "$INSTALL_CANONICAL" "$INSTALL_MARKER"
  validate_json_marker "$INSTALL_MARKER" 'application-installation'
  [ -f "$INSTALL_EXECUTABLE" ] && [ ! -L "$INSTALL_EXECUTABLE" ] || fail 'Research IDE executable is missing or unsafe'
  INSTALL_IDENTITY=$(directory_identity "$INSTALL_CANONICAL") || fail 'cannot identify installation directory'
fi

DATA_CANONICAL=''
if [ "$KEEP_DATA" -eq 0 ] && [ -e "$DATA_DIR" ]; then
  DATA_CANONICAL=$(canonical_directory "$DATA_DIR")
  [ "$(basename "$DATA_CANONICAL")" = 'Research IDE' ] || fail 'application-data directory name is not Research IDE'
  DATA_MARKER=$DATA_CANONICAL/.research-ide-app-data.json
  regular_marker_inside "$DATA_CANONICAL" "$DATA_MARKER"
  validate_json_marker "$DATA_MARKER" 'application-data'
  DATA_IDENTITY=$(directory_identity "$DATA_CANONICAL") || fail 'cannot identify application-data directory'
fi

STATE_CANONICAL=''
if [ "$KEEP_STATE" -eq 0 ] && [ -n "$STATE_DIR" ] && [ -e "$STATE_DIR" ]; then
  STATE_CANONICAL=$(canonical_directory "$STATE_DIR")
  [ "$(basename "$STATE_CANONICAL")" = 'research-ide' ] || fail 'launcher-state directory name is not research-ide'
  STATE_MARKER=$STATE_CANONICAL/.research-ide-launcher-state.json
  regular_marker_inside "$STATE_CANONICAL" "$STATE_MARKER"
  validate_json_marker "$STATE_MARKER" 'launcher-state'
  STATE_IDENTITY=$(directory_identity "$STATE_CANONICAL") || fail 'cannot identify launcher-state directory'
  [ "$STATE_CANONICAL" != "$DATA_CANONICAL" ] || fail 'application data and launcher state cannot be the same directory'
fi

canonical_confirmed() {
  expected=$1
  old_ifs=$IFS
  IFS='
'
  for value in $CONFIRMED_PROJECTS; do
    [ "$(canonical_directory "$value" 2>/dev/null || true)" = "$expected" ] && { IFS=$old_ifs; return 0; }
  done
  IFS=$old_ifs
  return 1
}

PROJECT_PLAN=''
old_ifs=$IFS
IFS='
'
for project in $PROJECTS; do
  [ -n "$project" ] || continue
  if [ "$DELETE_PROJECTS" -eq 0 ]; then
    printf 'KEEP project: %s\n' "$project"
    continue
  fi
  PROJECT_CANONICAL=$(canonical_directory "$project")
  PROJECT_TOML=$PROJECT_CANONICAL/.research_ide/project.toml
  PROJECT_SCHEMA=$PROJECT_CANONICAL/.research_ide/project.schema.json
  regular_marker_inside "$PROJECT_CANONICAL" "$PROJECT_TOML"
  regular_marker_inside "$PROJECT_CANONICAL" "$PROJECT_SCHEMA"
  grep -Eq '^schema_version[[:space:]]*=[[:space:]]*1[[:space:]]*$' "$PROJECT_TOML" || fail "project.toml schema marker is missing: $PROJECT_CANONICAL"
  grep -Eq '^id[[:space:]]*=[[:space:]]*"[A-Za-z0-9_-]{1,128}"[[:space:]]*$' "$PROJECT_TOML" || fail "project.toml project id is missing: $PROJECT_CANONICAL"
  grep -Fq 'https://research-ide.local/schemas/project.schema.json' "$PROJECT_SCHEMA" || fail "Research IDE schema identifier is missing: $PROJECT_CANONICAL"
  if ! canonical_confirmed "$PROJECT_CANONICAL"; then
    if [ "$EXECUTE" -eq 1 ] && [ -t 0 ]; then
      printf 'Type the exact project path to delete it:\n%s\n> ' "$PROJECT_CANONICAL" >&2
      IFS= read -r typed
      [ "$typed" = "$PROJECT_CANONICAL" ] || fail "project confirmation did not match: $PROJECT_CANONICAL"
    else
      fail "exact --confirm-project is required: $PROJECT_CANONICAL"
    fi
  fi
  PROJECT_IDENTITY=$(directory_identity "$PROJECT_CANONICAL") || fail 'cannot identify project directory'
  PROJECT_PLAN=$(append_line "$PROJECT_PLAN" "$PROJECT_CANONICAL|$PROJECT_IDENTITY")
done
IFS=$old_ifs

[ "$KEEP_INSTALLATION" -eq 1 ] || printf '%s installation: %s\n' "$([ "$EXECUTE" -eq 1 ] && printf REMOVE || printf PLAN)" "$INSTALL_CANONICAL"
[ "$KEEP_DATA" -eq 1 ] || { [ -z "$DATA_CANONICAL" ] || printf '%s application data: %s\n' "$([ "$EXECUTE" -eq 1 ] && printf REMOVE || printf PLAN)" "$DATA_CANONICAL"; }
[ "$KEEP_STATE" -eq 1 ] || { [ -z "$STATE_CANONICAL" ] || printf '%s launcher state: %s\n' "$([ "$EXECUTE" -eq 1 ] && printf REMOVE || printf PLAN)" "$STATE_CANONICAL"; }
if [ "$EXECUTE" -eq 0 ]; then
  [ -z "$PROJECT_PLAN" ] || printf '%s\n' "$PROJECT_PLAN" | while IFS='|' read -r project _identity; do printf 'PLAN project removal: %s\n' "$project"; done
  printf 'Dry run only; pass --execute to apply this validated plan.\n'
  exit 0
fi

if [ "$KEEP_INSTALLATION" -eq 0 ]; then
  if [ "$INSTALL_SYSTEM_PACKAGE" -eq 1 ]; then
    if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='${Status}' research-ide 2>/dev/null | grep -Fq 'install ok installed'; then
      if [ "$GRAPHICAL_AUTH" -eq 1 ]; then
        APT_GET=$(trusted_system_command apt-get) || fail 'apt-get is required for the installed Debian package'
        if [ "$(id -u)" -eq 0 ]; then
          "$APT_GET" remove -y -- research-ide
        else
          PKEXEC=$(trusted_system_command pkexec) || fail 'PolicyKit pkexec is required for graphical package removal'
          "$PKEXEC" "$APT_GET" remove -y -- research-ide
        fi
      elif [ "$(id -u)" -eq 0 ]; then
        apt-get remove -- research-ide
      else
        sudo -- apt-get remove -- research-ide
      fi
    elif command -v rpm >/dev/null 2>&1 && rpm -q research-ide >/dev/null 2>&1; then
      if command -v dnf >/dev/null 2>&1; then
        if [ "$GRAPHICAL_AUTH" -eq 1 ]; then
          DNF=$(trusted_system_command dnf) || fail 'dnf is required for the installed RPM package'
          if [ "$(id -u)" -eq 0 ]; then "$DNF" remove -y research-ide; else
            PKEXEC=$(trusted_system_command pkexec) || fail 'PolicyKit pkexec is required for graphical package removal'
            "$PKEXEC" "$DNF" remove -y research-ide
          fi
        elif [ "$(id -u)" -eq 0 ]; then dnf remove research-ide; else sudo -- dnf remove research-ide; fi
      else
        if [ "$GRAPHICAL_AUTH" -eq 1 ]; then
          RPM=$(trusted_system_command rpm) || fail 'rpm is required for the installed RPM package'
          if [ "$(id -u)" -eq 0 ]; then "$RPM" -e research-ide; else
            PKEXEC=$(trusted_system_command pkexec) || fail 'PolicyKit pkexec is required for graphical package removal'
            "$PKEXEC" "$RPM" -e research-ide
          fi
        elif [ "$(id -u)" -eq 0 ]; then rpm -e research-ide; else sudo -- rpm -e research-ide; fi
      fi
    else
      fail 'system installation is not owned by a recognized research-ide package'
    fi
  else
    [ "$(directory_identity "$INSTALL_CANONICAL" 2>/dev/null || true)" = "$INSTALL_IDENTITY" ] || fail 'installation directory changed before removal'
    remove_directory "$INSTALL_CANONICAL"
  fi
fi

if [ -n "$DATA_CANONICAL" ]; then
  [ "$(directory_identity "$DATA_CANONICAL" 2>/dev/null || true)" = "$DATA_IDENTITY" ] || fail 'application-data directory changed before removal'
  remove_directory "$DATA_CANONICAL"
fi

if [ -n "$STATE_CANONICAL" ]; then
  [ "$(directory_identity "$STATE_CANONICAL" 2>/dev/null || true)" = "$STATE_IDENTITY" ] || fail 'launcher-state directory changed before removal'
  remove_directory "$STATE_CANONICAL"
fi

if [ -n "$PROJECT_PLAN" ]; then
  printf '%s\n' "$PROJECT_PLAN" | while IFS='|' read -r project identity; do
    [ "$(directory_identity "$project" 2>/dev/null || true)" = "$identity" ] || fail "project changed before removal: $project"
    remove_directory "$project"
  done
fi

printf 'Research IDE uninstall plan completed.\n'
