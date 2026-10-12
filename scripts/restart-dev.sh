#!/bin/bash
# Khởi động lại dev server với .next sạch (Turbopack cache CSS cứng đầu)
DIR="$(cd "$(dirname "$0")/.." && pwd)"
pkill -f "next dev" 2>/dev/null
sleep 2
rm -rf "$DIR/.next"
cd "$DIR"
( setsid bun run dev </dev/null >>dev.log 2>&1 & )
for i in $(seq 1 30); do
  sleep 2
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ --max-time 10 2>/dev/null)
  if [ "$code" = "200" ]; then echo "dev server OK (lần thử $i)"; exit 0; fi
done
echo "dev server KHÔNG lên được — xem dev.log"
exit 1
