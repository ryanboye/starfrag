#!/bin/bash
# Purge Cloudflare cache for bmo.ryanboye.com. No args = purge everything;
# or pass specific URLs to purge just those. Creds from ~/.env.
set -a; source /home/claudebot/.env; set +a
if [ $# -eq 0 ]; then BODY='{"purge_everything":true}'
else FILES=$(printf '"%s",' "$@" | sed 's/,$//'); BODY="{\"files\":[$FILES]}"; fi
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json" \
  --data-raw "$BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);print('purge:','OK ✅' if d.get('success') else d.get('errors'))"
