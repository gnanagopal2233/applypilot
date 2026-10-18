import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "ApplyPilot", description: "Multi-agent job application pilot" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <header className="top">
            <h1>
              <a href="/">ApplyPilot</a>
            </h1>
            <span className="sub">scout → score → tailor (RAG) → verify → gate → apply</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
