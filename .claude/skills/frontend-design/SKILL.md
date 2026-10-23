---
name: frontend-design
description: Thiết kế & code frontend web (form, bảng, dashboard) cho hệ thống quản trị/SAP B1 — khi tạo/sửa UI, component, layout, styling, UX, accessibility, responsive.
---

# Frontend Design

## Nguyên tắc
- Theo stack & design system **đã có trong repo**. Tạo mới mặc định: React + TypeScript, component tách nhỏ, state rõ nguồn.
- Frontend chỉ gọi **API nội bộ**, không gọi thẳng Service Layer, không chứa credential B1.

## Hệ thiết kế (gu đã chốt cho hệ B1)
- Phong cách Fluent tối giản: surface trắng/neutral, bo góc ≤8px, không bóng mờ nặng, không gradient lòe loẹt.
- Màu: navy `#1E3A5F` = cấu trúc/chữ chính · gold `#F2B705` = accent duy nhất (CTA, highlight) · coral `#E0522F` = danger/quá hạn/lỗi.
- Typography rõ cấp bậc: 1 font, tối đa 3 mức size cho một màn hình thường. Số tiền/số lượng căn phải, dùng tabular-nums.
- Spacing theo lưới 4/8px. Mật độ vừa cho màn hình nghiệp vụ (bảng nhiều dòng), không làm "landing page" cho app vận hành.

## Cấu trúc & code
- Tách: `pages/` (route) · `components/` (dùng chung) · `features/<domain>/` · `api/` (client gọi API nội bộ) · `lib/` (format tiền/ngày, validate).
- Form: label luôn hiển thị, lỗi đặt dưới field, thông báo lỗi tiếng Việt + giữ mã lỗi gốc (tooltip/dòng phụ) khi API B1 trả về.
- Bảng dữ liệu: phân trang phía server, sort/filter qua query param, trạng thái loading/empty/error riêng biệt, không tải toàn bộ danh sách.
- Tránh re-render thừa: memo hoá hợp lý, debounce ô tìm kiếm (300ms), lazy-load route/heavy component.
- Ngày/giờ hiển thị theo `Asia/Ho_Chi_Minh`, định dạng `dd/MM/yyyy`; tiền VND không thập phân trừ khi nghiệp vụ yêu cầu.

## Accessibility & Responsive
- Mobile-first; bảng rộng → chuyển card list ở ≤640px, không để tràn ngang phải zoom.
- Đủ: focus visible, điều hướng bàn phím được trong dialog (focus trap + Esc đóng), `aria-label` cho nút icon, tương phản ≥ WCAG AA.
- Touch target ≥40px trên mobile.

## Kiểm tra trước khi giao
- [ ] Không hardcode URL/credential B1 · [ ] Có loading/empty/error state
- [ ] Kiểm tra 360px & desktop · [ ] Bàn phím qua được form/dialog · [ ] Build + lint pass
