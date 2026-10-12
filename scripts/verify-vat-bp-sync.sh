#!/bin/bash
# Verify E2E 2 màn đồng bộ Nhóm thuế + Khách hàng (root project, port 3000, mock SL 9090)
set -e
BASE=http://127.0.0.1:3000
J=/tmp/fm-verify-cookies.txt
rm -f $J

echo "=== 1) Đăng nhập Admin ==="
curl -s -c $J -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | head -c 120; echo

echo "=== 2) Cấu hình SL trỏ mock 9090 ==="
curl -s -b $J -X PUT $BASE/api/settings -H 'Content-Type: application/json' -d '{
  "serviceLayerUrl":"http://127.0.0.1:9090/b1s/v1","companyDb":"FM_TEST",
  "sapUser":"manager","sapPassword":"Sap@1234","sslSkipVerify":true,"connected":true}' | head -c 150; echo

echo "=== 3) VAT GET trước sync (chưa có dữ liệu) ==="
curl -s -b $J "$BASE/api/vatgroups/sync" | python3 -c "import json,sys; d=json.load(sys.stdin); print('total',d['total'],'| status',d['status'])"

echo "=== 4) VAT POST sync ==="
curl -s -b $J -X POST $BASE/api/vatgroups/sync | head -c 200; echo

echo "=== 5) VAT GET sau sync (tất cả) ==="
curl -s -b $J "$BASE/api/vatgroups/sync" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('total',d['total'],'page',d['page'],'| status',d['status'])
for r in d['data']: print('  ',r['code'],r['category'],r['name'],'rate=',r['rate'])"

echo "=== 6) VAT GET cat=P (chỉ Mua) + tìm không dấu ==="
curl -s -b $J "$BASE/api/vatgroups/sync?cat=P" | python3 -c "import json,sys; d=json.load(sys.stdin); print('cat=P total',d['total'])"
curl -s -b $J -G "$BASE/api/vatgroups/sync" --data-urlencode "q=vat 5" | python3 -c "import json,sys; d=json.load(sys.stdin); print('q=\"vat 5\" total',d['total'],[r['code'] for r in d['data']])"

echo "=== 7) BP POST sync ==="
curl -s -b $J -X POST $BASE/api/bpartners/sync | head -c 200; echo

echo "=== 8) BP GET sau sync + tìm ==="
curl -s -b $J "$BASE/api/bpartners/sync" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('total',d['total'],'| status',d['status'])
for r in d['data'][:4]: print('  ',r['cardCode'],'|',r['cardName'],'|',r['phone'],'|',r['email'])"
curl -s -b $J -G "$BASE/api/bpartners/sync" --data-urlencode "q=sieu thi" | python3 -c "import json,sys; d=json.load(sys.stdin); print('q=\"sieu thi\" total',d['total'],[r['cardCode'] for r in d['data']])"
curl -s -b $J "$BASE/api/bpartners/sync?q=0903" | python3 -c "import json,sys; d=json.load(sys.stdin); print('q=\"0903\" (điện thoại) total',d['total'],[r['cardCode'] for r in d['data']])"

echo "=== 9) RBAC: nhanvien POST phải 403 ==="
J2=/tmp/fm-verify-nv.txt; rm -f $J2
curl -s -c $J2 -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"nhanvien","password":"nhanvien123"}' > /dev/null
echo -n "VAT POST: "; curl -s -o /dev/null -w "%{http_code}\n" -b $J2 -X POST $BASE/api/vatgroups/sync
echo -n "VAT GET:  "; curl -s -o /dev/null -w "%{http_code}\n" -b $J2 $BASE/api/vatgroups/sync
echo -n "BP POST:  "; curl -s -o /dev/null -w "%{http_code}\n" -b $J2 -X POST $BASE/api/bpartners/sync

echo "=== 10) VAT DELETE (xóa sạch) rồi sync lại ==="
curl -s -b $J -X DELETE $BASE/api/vatgroups/sync | head -c 120; echo
curl -s -b $J "$BASE/api/vatgroups/sync" | python3 -c "import json,sys; d=json.load(sys.stdin); print('sau DELETE total',d['total'])"
curl -s -b $J -X POST $BASE/api/vatgroups/sync | head -c 150; echo

echo "=== 11) Regression: /api/partners + /api/items vẫn chạy ==="
curl -s -b $J "$BASE/api/partners?q=C20001" | python3 -c "import json,sys; d=json.load(sys.stdin); print('partners source',d.get('source'),'total',d.get('total'))"
curl -s -b $J "$BASE/api/items?q=RAU" | python3 -c "import json,sys; d=json.load(sys.stdin); print('items total',d.get('total'))"
echo "DONE"
