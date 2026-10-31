import type { Metadata, Viewport } from "next";
import { Roboto } from "next/font/google";
import "./globals.css";

const roboto = Roboto({
  subsets: ["latin"],
  weight: ["300", "400", "500", "700"],
  variable: "--font-roboto",
  display: "swap",
});

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: { default: "Softilo ERP", template: "%s · Softilo ERP" },
  description: "Accounts, stock and landed cost for UK importers and wholesalers.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#191712" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0c09" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={roboto.variable}>
      <body>{children}</body>
    </html>
  );
}
