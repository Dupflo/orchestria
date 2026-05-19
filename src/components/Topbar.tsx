"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_TABS = [
  { label: "Mesh",      href: "/visualizer" },
  { label: "Agents",    href: "/agents" },
  { label: "Chat",      href: "/chat" },
  { label: "Memory",    href: "/memory" },
  { label: "Missions",  href: "/missions" },
  { label: "Board",     href: "/kanban" },
  { label: "Skills",    href: "/skills" },
  { label: "Routines",  href: "/routines" },
  { label: "Dashboard", href: "/dashboard" },
];

export default function Topbar() {
  const pathname = usePathname();

  return (
    <header className="os-top">
      <div className="os-brand">
        <Image
          className="os-brand-logo"
          src="/logo.png"
          alt="OrchestrIA"
          width={22}
          height={22}
          priority
        />
        <div>
          <div className="os-brand-name">
            OrchestrIA <span className="os-brand-sub mono">0.42.1</span>
          </div>
        </div>
      </div>
      <nav className="os-tabs">
        {NAV_TABS.map((tab) => {
          const isActive =
            tab.href === "/visualizer"
              ? pathname === "/" || pathname.startsWith("/visualizer")
              : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`os-tab${isActive ? " active" : ""}`}
            >
              <span className="dot" />
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <div className="os-top-right">
        <span className="mono" style={{ color: "var(--text-faint)" }}>
          tenant _main
        </span>
        <div className="os-pill">
          <span className="pulse" />
          <span>local · airgapped</span>
        </div>
      </div>
    </header>
  );
}
