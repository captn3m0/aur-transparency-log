#!/bin/sh
# Deploys the aur-tl Worker code; the bucket, Worker shell and domain are managed by nebula/cloudflare/aur-tl.tf.
set -eu
cd "$(dirname "$0")"
W="npx --yes wrangler@4"
$W secret put SIGNING_KEY < "${SIGNING_KEY_FILE:-../.secrets/worker.pem}"
$W deploy
