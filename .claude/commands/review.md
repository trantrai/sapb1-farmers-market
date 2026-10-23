---
description: Rà soát thay đổi hiện tại (git diff) theo checklist bảo mật + chất lượng
---

Rà soát `git diff` hiện tại (kể cả file chưa staged) theo skill `security`:
1. Quét secret: password, key, token, cookie, connection string thật trong diff.
2. Kiểm tra: validate/RBAC ở server, tham số hoá query, call B1 có `$select`/timeout/session tái dùng, log có mask.
3. Kiểm tra test đi kèm và phạm vi thay đổi có đúng yêu cầu không.

Trình bày: Blocker / Major / Minor / Verdict (merge được hay chưa). Ngắn gọn, kèm file:dòng.
