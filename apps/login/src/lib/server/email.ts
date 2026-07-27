"use server";

import { createLogger } from "@/lib/logger";
import { getServiceConfig } from "@/lib/service-url";
import { loadMostRecentSession } from "@/lib/session";
import { setEmail } from "@/lib/zitadel";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { resendVerification } from "./verify";

const logger = createLogger("email-update");

export type UpdateEmailCommand = {
  email: string;
  // used only to select among the caller's OWN sessions; the userId is always
  // taken from the resolved session, never from client input
  loginName?: string;
  organization?: string;
  requestId?: string;
};

/**
 * Self-service email change (the /email page). Sets the signed-in user's email;
 * unless EMAIL_UPDATE_MARK_VERIFIED=true, Zitadel sends a verification code to
 * the new address and we route the user to /verify to confirm. Requires SMTP
 * to be configured for the code to actually be delivered.
 */
export async function updateEmail(command: UpdateEmailCommand) {
  const _headers = await headers();
  const { serviceConfig } = getServiceConfig(_headers);
  const t = await getTranslations("email");

  const session = await loadMostRecentSession({
    serviceConfig,
    sessionParams: { loginName: command.loginName, organization: command.organization },
  });

  const userId = session?.factors?.user?.id;
  if (!userId) {
    return { error: t("errors.noSession") };
  }

  const markVerified = process.env.EMAIL_UPDATE_MARK_VERIFIED === "true";

  try {
    await setEmail({ serviceConfig, userId, email: command.email, verified: markVerified });
  } catch (error) {
    logger.error("setEmail failed", { error: error instanceof Error ? error.message : String(error) });
    return { error: t("errors.couldNotUpdate") };
  }

  // verified inline → back to the account overview; otherwise confirm the code
  if (markVerified) {
    const params = new URLSearchParams();
    if (session?.factors?.user?.loginName) params.set("loginName", session.factors.user.loginName);
    if (command.organization) params.set("organization", command.organization);
    return { redirect: params.toString() ? `/signedin?${params}` : "/signedin" };
  }

  const params = new URLSearchParams({ userId });
  if (session?.factors?.user?.loginName) params.set("loginName", session.factors.user.loginName);
  if (command.organization) params.set("organization", command.organization);
  if (command.requestId) params.set("requestId", command.requestId);
  return { redirect: `/verify?${params}` };
}

/**
 * Send a verification code for the signed-in user's CURRENT (unverified) email
 * and route to /verify. Used by the "verify now" action on the /email page.
 */
export async function sendCurrentEmailVerification(command: { loginName?: string; organization?: string; requestId?: string }) {
  const _headers = await headers();
  const { serviceConfig } = getServiceConfig(_headers);
  const t = await getTranslations("email");

  const session = await loadMostRecentSession({
    serviceConfig,
    sessionParams: { loginName: command.loginName, organization: command.organization },
  });

  const userId = session?.factors?.user?.id;
  if (!userId) {
    return { error: t("errors.noSession") };
  }

  const result = await resendVerification({ userId, isInvite: false, requestId: command.requestId });
  if (result && "error" in result && result.error) {
    return { error: result.error };
  }

  const params = new URLSearchParams({ userId });
  if (session?.factors?.user?.loginName) params.set("loginName", session.factors.user.loginName);
  if (command.organization) params.set("organization", command.organization);
  if (command.requestId) params.set("requestId", command.requestId);
  return { redirect: `/verify?${params}` };
}
