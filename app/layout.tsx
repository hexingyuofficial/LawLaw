import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LawLaw 工作台",
  description: "法律 AI 助手工作台 UI 骨架",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
