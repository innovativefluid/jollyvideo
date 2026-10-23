#!/usr/bin/env bash
# Jollyvideo in a real Sharkord, with Sharkord's own end-to-end setup: a
# seeded server, its Vite client and Playwright. Needs network, ffmpeg
# (JOLLYVIDEO_FFMPEG) and a built plugin (bun run build).
#
#   bun run test:e2e
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
e2e="$root/.sharkord/packages/e2e"
[ -d "$root/.sharkord" ] || (cd "$root" && bun run sharkord)
[ -d "$root/dist/jollyvideo" ] || (cd "$root" && bun run build)

(cd "$root/.sharkord" && bun install --frozen-lockfile)
(cd "$e2e" && bunx playwright install --with-deps chromium)

# Sharkord's seed: users (testowner/password123), a "Voice" channel, plugins on
(cd "$e2e" && bun run seed:e2e)
work=$(mktemp -d)
set -a
# shellcheck disable=SC1090
source <(bun "$root/e2e/setup.ts" "$e2e/e2e-data" "$work")
set +a

cp "$root/e2e/jollyvideo.pw.ts" "$e2e/tests/jollyvideo.pw.ts"
export JOLLYVIDEO_SCREENSHOT="${JOLLYVIDEO_SCREENSHOT:-$root/dist/e2e/jollyvideo.png}"
mkdir -p "$(dirname "$JOLLYVIDEO_SCREENSHOT")"
cd "$e2e"
CI=1 bunx playwright test tests/jollyvideo.pw.ts --reporter=github,list
