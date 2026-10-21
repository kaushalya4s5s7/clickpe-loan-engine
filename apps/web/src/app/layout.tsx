import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Outfit } from "next/font/google";
import type { ReactNode } from "react";
import { ApiKeyDialog } from "@/components/ApiKeyDialog";
import { ApiProvider } from "@/components/ApiProvider";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { SetupNotice } from "@/components/SetupNotice";
import "./globals.css";

// Self-hosted at build time by next/font: no request to Google from the user's browser.
const outfit = Outfit({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const display = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Loan Match", template: "%s · Loan Match" },
  description: "Upload a lead list; every person is matched to the personal loans they are likely to qualify for and emailed their options.",
  robots: { index: false, follow: false }, // internal operations console
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN" className={`${outfit.variable} ${display.variable}`}>
      <body>
        <ApiProvider>
          <div className="frame">
            <Nav />
            <SetupNotice />
            <main style={{ flex: 1 }}>{children}</main>
            <Footer />
          </div>
          <ApiKeyDialog />
        </ApiProvider>
      </body>
    </html>
  );
}
