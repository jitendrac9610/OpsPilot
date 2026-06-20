import type { Metadata } from "next";
import { Outfit, Space_Grotesk } from "next/font/google";
import "./global.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  weight: ["300", "400", "500", "600", "700"],
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "OpsPilot AI — Agentic Software Reliability Platform",
  description: "Connect your repository, map architecture, discover synthetic test workflows, and automate verified sandbox remediation.",
  keywords: ["DevOps", "AI Agent", "Software Reliability", "SRE", "Automated Repair"],
  authors: [{ name: "OpsPilot Team" }],
  openGraph: {
    title: "OpsPilot AI",
    description: "Multi-tenant, adapter-driven agentic software reliability platform.",
    type: "website"
  }
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${outfit.variable} ${spaceGrotesk.variable}`}>
      <body>
        <div className="bg-glow-purple"></div>
        <div className="bg-glow-cyan"></div>
        {children}
      </body>
    </html>
  );
}
