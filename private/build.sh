#!/usr/bin/env bash
# Build the private dashboard: settings from config.yaml, and the public site's presentation
# mode copied to public/present/ with a data source that adds names (served behind Access only).
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m collector.worker_config private/src/config.json
rm -rf private/public/present
mkdir -p private/public/present
cp site/index.html site/app.js site/present.js site/style.css private/public/present/
# config.js: the public settings plus the private data source (instead of the CSV links).
cat site/config.js private/present-source.js > private/public/present/config.js
echo "built private/public/present"
