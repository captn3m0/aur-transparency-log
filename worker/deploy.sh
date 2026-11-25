#!/bin/sh
# Ships the Worker code; bucket, Worker shell, domain and SIGNING_KEY secret are managed by nebula/cloudflare/aur-tl.tf.
set -eu
cd "$(dirname "$0")"
CLOUDFLARE_API_TOKEN="$(cd "${NEBULA:-$HOME/projects/personal/nebula}/cloudflare" && tofu output -raw aur_tl_cloudflare_api_token)"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=34c97bfc648a63e10eb2a368ad302011
npx --yes wrangler@4 deploy
