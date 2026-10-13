/** Phân trang dùng chung — thống nhất 1 kiểu cho mọi màn hình */
export default function FmPagination({
  page,
  totalPages,
  onPage,
}: {
  page: number
  totalPages: number
  onPage: (p: number) => void
}) {
  if (totalPages <= 1) return null
  const nums = Array.from({ length: totalPages }, (_, i) => i + 1)
    .filter((p) => Math.abs(p - page) <= 1 || p === 1 || p === totalPages)
  return (
    <div className="fm-pagination">
      <span style={{ color: 'var(--fm-text-2)', marginRight: 8 }}>
        Trang {page}/{totalPages}
      </span>
      <button className="fm-page-btn" aria-label="Về trang đầu" disabled={page <= 1} onClick={() => onPage(1)}>«</button>
      <button className="fm-page-btn" aria-label="Trang trước" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button>
      {nums.map((p) => (
        <button
          key={p}
          className={`fm-page-btn${p === page ? ' is-active' : ''}`}
          aria-label={`Trang ${p}`}
          aria-current={p === page ? 'page' : undefined}
          onClick={() => onPage(p)}
        >
          {p}
        </button>
      ))}
      <button className="fm-page-btn" aria-label="Trang sau" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>›</button>
      <button className="fm-page-btn" aria-label="Đến trang cuối" disabled={page >= totalPages} onClick={() => onPage(totalPages)}>»</button>
    </div>
  )
}
