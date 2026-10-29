#!/usr/bin/env bash
# Local runner used by the launchd service (see docs/deploy-macos.md).
set -euo pipefail
cd "$(dirname "$0")"
exec node --env-file=.env dist/server.js
