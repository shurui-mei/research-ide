#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P)
exec /bin/sh "$ROOT/apps/desktop/resources/uninstall/uninstall-research-ide.sh" "$@"
