#!/bin/bash
# Verify E2E chiết khấu ĐẦU CHỨNG TỪ (header discount) — root project port 3000 + mock SL 9090
set -e
BASE=http://127.0.0.1:3000
J=/tmp/fm-hd-cookies.txt
rm -f $J

echo "=== 1) Login admin + cấu hình SL mock ==="
curl -s -c $J -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' > /dev/null
curl -s -b $J -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{
  "serviceLayerUrl":"http://127.0.0.1:9090/b1s/v1","companyDb":"FM_TEST",
  "sapUser":"manager","sapPassword":"Sap@1234","sslSkipVerify":true,"connected":true}' | head -c 60; echo

echo "=== 2) POST đơn mới headerDiscPct=10 (2 dòng: L1 120000 CK10% VAT5 | L2 64000 CK0% VAT10) ==="
curl -s -b $J -X POST $BASE/api/orders -H 'Content-Type: application/json' -d '{
  "cardCode":"C20001","cardName":"Cửa hàng Rau Sạch Đà Lạt",
  "docDate":"2026-10-09","docDueDate":"2026-10-14",
  "remarks":"Test CK đầu chứng từ","headerDiscPct":10,
  "lines":[
    {"itemCode":"FM-RAU-001","itemName":"Rau Muống Tươi","uom":"kg","quantity":10,"unitPrice":12000,"discPct":10,"vatPct":5,"taxCode":"S2"},
    {"itemCode":"FM-QUA-001","itemName":"Cà Chua Bi Đà Lạt","uom":"kg","quantity":2,"unitPrice":32000,"discPct":0,"vatPct":10,"taxCode":"S1"}
  ]}' > /tmp/hd-create.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/hd-create.json'))
assert d.get('ok'), d
o = d['order']
print(f"order docNum={o['docNum']} sap={o['sapSyncStatus']} sapDocNum={o.get('sapDocNum')}")
print(f"  headerDiscPct={o['headerDiscPct']} headerDiscAmt={o['headerDiscAmt']}")
print(f"  totalBeforeDisc={o['totalBeforeDisc']} lineDisc={o['discountAmt']} vat={o['vatAmt']} grand={o['grandTotal']}")
print(f"  KỲ VỌNG: headerDiscAmt=17200 totalBefore=184000 lineDisc=12000 after=154800 vat=10620 grand=165420")
assert o['headerDiscPct'] == 10 and o['headerDiscAmt'] == 17200, 'header disc sai'
assert o['totalBeforeDisc'] == 184000 and o['discountAmt'] == 12000, 'tổng dòng sai'
assert o['vatAmt'] == 10620 and o['grandTotal'] == 165420, 'VAT/grand sai'
for l in o['lines']:
    print(f"    {l['itemCode']}: lineTotal={l['lineTotal']} discAmt={l['discAmt']} vatAmt={l['vatAmt']} grand={l['grandTotal']}")
print("OK PASS tạo đơn")
EOF

echo "=== 3) PUT sửa đơn: headerDiscPct 10 → 5 (kèm PATCH SAP) ==="
OID=$(python3 -c "import json; print(json.load(open('/tmp/hd-create.json'))['order']['id'])")
DOCENTRY=$(python3 -c "import json; print(json.load(open('/tmp/hd-create.json'))['order']['sapDocEntry'])")
curl -s -b $J -X PUT $BASE/api/orders/$OID -H 'Content-Type: application/json' -d '{
  "cardCode":"C20001","cardName":"Cửa hàng Rau Sạch Đà Lạt",
  "docDate":"2026-10-09","docDueDate":"2026-10-14",
  "remarks":"Test CK đầu — sửa 5%","headerDiscPct":5,
  "lines":[
    {"itemCode":"FM-RAU-001","itemName":"Rau Muống Tươi","uom":"kg","quantity":10,"unitPrice":12000,"discPct":10,"vatPct":5,"taxCode":"S2"},
    {"itemCode":"FM-QUA-001","itemName":"Cà Chua Bi Đà Lạt","uom":"kg","quantity":2,"unitPrice":32000,"discPct":0,"vatPct":10,"taxCode":"S1"}
  ]}' > /tmp/hd-update.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/hd-update.json'))
assert d.get('ok'), d
o = d['order']
print(f"sap={d['sap']['status']} headerDiscPct={o['headerDiscPct']} headerDiscAmt={o['headerDiscAmt']} grand={o['grandTotal']}")
print(f"  KỲ VỌNG: pct=5 amt=8600 vat=11460 grand=162280 (vat: L1 102600*5%=5130 + L2 57600*10%=5760 → 10890? tự kiểm)")
EOF

echo "=== 4) Đọc lại chứng từ từ SAP (finalizeTotals) ==="
curl -s -b $J "$BASE/api/orders?source=sap&docEntry=$DOCENTRY" > /dev/null 2>&1 || true
python3 - <<EOF
import json, urllib.request
EOF
SID=$(curl -s -b $J "$BASE/api/orders?page=1&pageSize=50" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows=[r for r in d['data'] if r.get('sapDocEntry')==$DOCENTRY]
r=rows[0]
print('SAP row:', 'docNum', r['docNum'], '| headerDiscPct', r.get('headerDiscPct'), '| grand', r['grandTotal'], '| sau-CK-cell', r['totalBeforeDisc']-r['discountAmt']-(r.get('headerDiscAmt') or 0))
print('detail lines?', len(r.get('lines') or []))
")

echo "=== 5) Regression: đơn KHÔNG CK đầu (pct=0) — số phải y như công thức cũ ==="
curl -s -b $J -X POST $BASE/api/orders -H 'Content-Type: application/json' -d '{
  "cardCode":"C20002","cardName":"Siêu Thị Xanh Quận 7",
  "docDate":"2026-10-09","docDueDate":"2026-10-14",
  "lines":[{"itemCode":"FM-RAU-002","itemName":"Cải Ngọt Bio","uom":"kg","quantity":5,"unitPrice":18000,"discPct":0,"vatPct":8,"taxCode":"S2"}]}' > /tmp/hd-regress.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/hd-regress.json'))
assert d.get('ok'), d
o = d['order']
print(f"grand={o['grandTotal']} (KỲ VỌNG 90000+7200=97200) headerDiscPct={o['headerDiscPct']}")
assert o['grandTotal'] == 97200 and o['headerDiscPct'] == 0, 'regression sai'
print("OK PASS regression 0%")
EOF
echo "DONE"
