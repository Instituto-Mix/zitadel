import { Button, ButtonVariants } from "@/components/button";
import { Translated } from "@/components/translated";
import Link from "next/link";

type NavPage = "accounts" | "apps" | "email" | "logout";

/**
 * Footer-like navigation row (fork feature) linking the session pages:
 * Accounts, Applications (/apps) and Logout. Used on /signedin and /apps.
 * The current page's own link is omitted.
 */
export function NavLinks({ current, emailPending }: { current?: NavPage; emailPending?: boolean }) {
  const items: { page: NavPage; href: string; namespace: string }[] = [
    { page: "accounts", href: "/accounts", namespace: "accounts" },
    { page: "apps", href: "/apps", namespace: "apps" },
    { page: "email", href: "/email", namespace: "email" },
    { page: "logout", href: "/logout", namespace: "logout" },
  ];

  return (
    <div className="mt-8 flex w-full flex-row items-center justify-between">
      {items
        .filter((item) => item.page !== current)
        .map((item) => {
          const showBadge = item.page === "email" && emailPending;
          return (
            <Link key={item.page} href={item.href} className="relative">
              {showBadge && (
                <span
                  aria-hidden
                  className="absolute -right-1 -top-1 z-10 h-2.5 w-2.5 rounded-full bg-yellow-400 ring-2 ring-background-light-400 dark:ring-background-dark-500"
                />
              )}
              <Button type="button" variant={ButtonVariants.Secondary}>
                <Translated i18nKey="title" namespace={item.namespace} />
              </Button>
            </Link>
          );
        })}
    </div>
  );
}
