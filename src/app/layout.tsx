import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-fm",
  subsets: ["latin", "vietnamese"],
});

export const metadata: Metadata = {
  title: "Farmers Market — Đơn hàng bán SAP B1",
  description:
    "Hệ thống quản lý đơn hàng bán tích hợp SAP Business One của Farmers Market — tạo đơn, theo dõi trạng thái, quản lý ủy quyền.",
  icons: {
    icon: "/logo-farmers-market.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body className={`${inter.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
