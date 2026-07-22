import { Button, ButtonVariants } from "@/components/button";
import { Translated } from "@/components/translated";
import Link from "next/link";

type NavPage = "accounts" | "apps" | "logout";

/**
 * Footer-like navigation row (fork feature) linking the session pages:
 * Accounts, Applications (/apps) and Logout. Used on /signedin and /apps.
 * The current page's own link is omitted.
 */
export function NavLinks({ current }: { current?: NavPage }) {
  const items: { page: NavPage; href: string; namespace: string }[] = [
    { page: "accounts", href: "/accounts", namespace: "accounts" },
    { page: "apps", href: "/apps", namespace: "apps" },
    { page: "logout", href: "/logout", namespace: "logout" },
  ];

  return (
    <div className="mt-8 flex w-full flex-row items-center justify-between">
      {items
        .filter((item) => item.page !== current)
        .map((item) => (
          <Link key={item.page} href={item.href}>
            <Button type="button" variant={ButtonVariants.Secondary}>
              <Translated i18nKey="title" namespace={item.namespace} />
            </Button>
          </Link>
        ))}
    </div>
  );
}
