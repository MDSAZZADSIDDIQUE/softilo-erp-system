import type { Metadata, Viewport } from "next";
import { Roboto } from "next/font/google";
import "@/app/globals.css";
import "./mfg.css";

const roboto = Roboto({
  subsets: ["latin"],
  weight: ["300", "400", "500", "700"],
  variable: "--font-roboto",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Softilo for Manufacturing", template: "%s · Softilo" },
  description: "Accounts, stock and production costing for UK makers and assemblers.",
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
