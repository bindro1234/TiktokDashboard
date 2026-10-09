#!/usr/bin/env bash
# Build the private dashboard: settings from config.yaml, the commit being built, and the public site's presentation
# mode copied to public/present/ with a data source that adds names (served behind Access only).
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m collector.worker_config private/src/config.json
# The commit this build comes from. The Worker reports it in a response header (and on /version), and the
# deploy job checks that the live Worker reports the commit it just deployed. "dev" outside Actions.
commit="${GITHUB_SHA:-dev}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || commit="dev"
printf '{"commit":"%s"}\n' "$commit" > private/src/version.json
rm -rf private/public/present
mkdir -p private/public/present
cp site/index.html site/app.js site/present.js site/style.css private/public/present/
# config.js: the public settings plus the private data source (instead of the CSV links).
cat site/config.js private/present-source.js > private/public/present/config.js
echo "built private/public/present"
