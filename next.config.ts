import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Chống MIME-sniffing
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Không gửi referrer chi tiết sang site khác
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Tắt các API nhạy cảm của trình duyệt không dùng tới
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          // CSP thực dụng: app dùng nhiều inline style/script của Next.js nên
          // cho phép 'unsafe-inline'; chặn object/embed, giới hạn base-uri và
          // form-action để giảm bề mặt XSS. KHÔNG đặt frame-ancestors vì app
          // được nhúng qua iframe preview cross-site (xem fm-client.ts).
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' data: https://fonts.gstatic.com",
              "img-src 'self' data: blob:",
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
