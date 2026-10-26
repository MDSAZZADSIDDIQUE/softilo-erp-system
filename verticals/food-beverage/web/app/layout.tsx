import type { Metadata, Viewport } from "next";
import { Roboto } from "next/font/google";
import "@core/app/globals.css";
import "./fnb.css";

const roboto = Roboto({
  subsets: ["latin"],
  weight: ["300", "400", "500", "700"],
  variable: "--font-roboto",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Softilo Food & Drink", template: "%s · Softilo" },
  description: "Accounts, stock, batches and traceability for UK food and drink wholesalers and producers.",
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
