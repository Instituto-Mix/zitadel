"use client";

import { getInitials } from "@/components/avatar";
import { useState } from "react";

/**
 * Icon for an /apps launcher card: the app's favicon when it loads, otherwise
 * initials derived from the app name (same scheme as the user avatar).
 */
export function AppIcon({ name, favicon }: { name: string; favicon: string | null }) {
  const [failed, setFailed] = useState(false);

  if (favicon && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external favicon, not an optimizable asset
      <img
        src={favicon}
        alt=""
        aria-hidden
        width={32}
        height={32}
        className="h-8 w-8 shrink-0 rounded"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      aria-hidden
      className="bg-primary-light-500 dark:bg-primary-dark-500 flex h-8 w-8 shrink-0 items-center justify-center rounded text-sm font-medium text-white"
    >
      {getInitials(name, name)}
    </div>
  );
}
