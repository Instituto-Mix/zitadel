"use client";

import { ReactNode } from "react";

/**
 * Launcher card link: opens the app in a named tab (one tab per app, reused on
 * re-click) and explicitly focuses it — plain target= navigation reuses the
 * tab but doesn't reliably foreground it.
 *
 * Caveat (accepted): if a cross-origin app sends COOP: same-origin, the name
 * association is severed by the browser and clicks open fresh tabs — nothing
 * a launcher can do about that.
 */
export function AppLink({
  href,
  name,
  title,
  className,
  children,
}: {
  href: string;
  name: string;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target={name}
      title={title}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        window.open(href, name)?.focus();
      }}
    >
      {children}
    </a>
  );
}
