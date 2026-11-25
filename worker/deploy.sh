#!/bin/sh
# Deploys the aur-tl Worker: R2 bucket, signing secret, Worker, cron and custom domain.
set -eu
cd "$(dirname "$0")"
W="npx --yes wrangler@4"
$W r2 bucket create aur-tl 2>&1 | tail -2 || true
$W secret put SIGNING_KEY < "${SIGNING_KEY_FILE:-../.secrets/worker.pem}"
$W deploy
