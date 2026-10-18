import type { ReactNode } from "react";
import TaskBar from "./components/TaskBar";
import "./globals.css";

export const metadata = { title: "ApplyPilot", description: "Job application pilot: find, score, tailor, check and apply." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="topnav">
          <div className="wrap topnav-inner">
            <a href="/" className="logo">
              ApplyPilot
            </a>
            <div className="links">
              <a href="/">Pipeline</a>
              <a href="/?status=review">Review queue</a>
              <a href="/?status=submitted">Submitted</a>
              <a href="/settings">Settings</a>
            </div>
          </div>
        </nav>
        <div className="wrap">
          <TaskBar />
          {children}
        </div>
      </body>
    </html>
  );
}
