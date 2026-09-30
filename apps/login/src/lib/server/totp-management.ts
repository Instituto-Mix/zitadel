"use server";

import { AuthenticationMethodType } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getSessionCookieById } from "../cookies";
import { getServiceConfig } from "../service-url";
import { isSessionValid } from "../session";
import { getSession, listAuthenticationMethodTypes, removeTOTP } from "../zitadel";

export async function removeManagedTOTP(sessionId: string): Promise<{ success: true } | { error: string }> {
  try {
    if (!sessionId) {
      return { error: "Could not determine the selected session" };
    }

    const requestHeaders = await headers();
    const { serviceConfig } = getServiceConfig(requestHeaders);
    const sessionCookie = await getSessionCookieById({ sessionId });

    if (!sessionCookie) {
      return { error: "Could not get session cookie" };
    }

    const sessionResponse = await getSession({
      serviceConfig,
      sessionId: sessionCookie.id,
      sessionToken: sessionCookie.token,
    });
    const session = sessionResponse?.session;
    const userId = session?.factors?.user?.id;

    if (!session || session.id !== sessionId || !userId) {
      return { error: "Could not determine user from session" };
    }

    if (!(await isSessionValid({ serviceConfig, session }))) {
      return { error: "You have to authenticate with a valid session before removing an authenticator" };
    }

    const methods = await listAuthenticationMethodTypes({ serviceConfig, userId });
    if (!methods.authMethodTypes?.includes(AuthenticationMethodType.TOTP)) {
      return { error: "No authenticator app is configured for this account" };
    }

    await removeTOTP({ serviceConfig, userId });
    revalidatePath("/authenticator/set");

    return { success: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not remove authenticator app" };
  }
}
