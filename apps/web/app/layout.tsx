import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lead lifecycle pipeline",
  description:
    "Ad click to lead to agent triage to sales outcome to ad-platform conversion, with proof at every hop. Synthetic data only.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
