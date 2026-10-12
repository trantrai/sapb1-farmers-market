import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const inter = Inter({
  variable: "--font-fm",
  subsets: ["latin", "vietnamese"],
});

export const metadata: Metadata = {
  title: "Farmers Market — SAP B1 Sale Order",
  description:
    "Hệ thống quản lý Sale Order tích hợp SAP Business One của Farmers Market — tạo đơn, theo dõi trạng thái, phân quyền RBAC.",
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
        <Toaster />
      </body>
    </html>
  );
}
