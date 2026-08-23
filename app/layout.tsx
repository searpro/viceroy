import type { Metadata } from "next";
import { AppNav } from "./components/app-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Viceroy",
  description: "Story-to-video generator",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <AppNav />
        {children}
      </body>
    </html>
  );
}
