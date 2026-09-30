"use server";

import { timestampDate } from "@zitadel/client";
import { Session } from "@zitadel/proto/zitadel/session/v2/session_pb";
import { AuthFactorState, Passkey } from "@zitadel/proto/zitadel/user/v2/user_pb";
import { AuthenticationMethodType } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getSessionCookieById } from "../cookies";
import { getServiceConfig } from "../service-url";
import { isSessionValid } from "../session";
import { getSession, listAuthenticationMethodTypes, listPasskeys, removePasskey, ServiceConfig } from "../zitadel";

type ManagedSession = { serviceConfig: ServiceConfig; userId: string } | { error: string };

const passkeyRemovalQueues = new Map<string, Promise<void>>();

async function withPasskeyRemovalLock<T>(userId: string, action: () => Promise<T>): Promise<T> {
  const previous = passkeyRemovalQueues.get(userId);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  passkeyRemovalQueues.set(userId, current);
  await previous;

  try {
    return await action();
  } finally {
    release();
    if (passkeyRemovalQueues.get(userId) === current) {
      passkeyRemovalQueues.delete(userId);
    }
  }
}

function hasValidSignInFactor(session: Session): boolean {
  const factors = session.factors;
  const verifiedFactor =
    factors?.password?.verifiedAt ||
    (factors?.webAuthN?.userVerified && factors?.webAuthN?.verifiedAt) ||
    factors?.intent?.verifiedAt;
  const notExpired = !session.expirationDate || timestampDate(session.expirationDate).getTime() > Date.now();

  return !!(factors?.user?.id && verifiedFactor && notExpired);
}

async function resolveManagedSession(sessionId: string): Promise<ManagedSession> {
  if (!sessionId) {
    return { error: "An authenticated session is required to manage passkeys." };
  }

  try {
    const requestHeaders = await headers();
    const { serviceConfig } = getServiceConfig(requestHeaders);
    const sessionCookie = await getSessionCookieById({ sessionId });

    if (!sessionCookie) {
      return { error: "An authenticated session is required to manage passkeys." };
    }

    const response = await getSession({
      serviceConfig,
      sessionId: sessionCookie.id,
      sessionToken: sessionCookie.token,
    });
    const session = response?.session;
    const userId = session?.factors?.user?.id;

    if (
      !session ||
      session.id !== sessionId ||
      !userId ||
      !hasValidSignInFactor(session) ||
      !(await isSessionValid({ serviceConfig, session }))
    ) {
      return { error: "A current, verified session is required to manage passkeys." };
    }

    return { serviceConfig, userId };
  } catch {
    return { error: "Could not verify the selected session." };
  }
}

export async function listManagedPasskeys(sessionId: string): Promise<{ passkeys: Passkey[] } | { error: string }> {
  const managedSession = await resolveManagedSession(sessionId);
  if ("error" in managedSession) {
    return managedSession;
  }

  try {
    const response = await listPasskeys({ serviceConfig: managedSession.serviceConfig, userId: managedSession.userId });
    return { passkeys: response.result ?? [] };
  } catch {
    return { error: "Could not list passkeys for this session." };
  }
}

export async function removeManagedPasskey(
  sessionId: string,
  passkeyId: string,
): Promise<{ success: true } | { error: string }> {
  const managedSession = await resolveManagedSession(sessionId);
  if ("error" in managedSession) {
    return managedSession;
  }

  const result = await withPasskeyRemovalLock(
    managedSession.userId,
    async (): Promise<{ success: true } | { error: string }> => {
      let passkeys: Passkey[];
      try {
        const response = await listPasskeys({ serviceConfig: managedSession.serviceConfig, userId: managedSession.userId });
        passkeys = response.result ?? [];
      } catch {
        return { error: "Could not verify ownership of this passkey." };
      }

      const passkey = passkeys.find((candidate) => candidate.id === passkeyId);
      if (!passkey) {
        return { error: "This passkey does not belong to the signed-in account." };
      }

      const anotherUsablePasskeyRemains = passkeys.some(
        (candidate) => candidate.id !== passkeyId && candidate.state === AuthFactorState.READY,
      );

      if (passkey.state === AuthFactorState.READY && !anotherUsablePasskeyRemains) {
        let authenticationMethodTypes: AuthenticationMethodType[];
        try {
          const response = await listAuthenticationMethodTypes({
            serviceConfig: managedSession.serviceConfig,
            userId: managedSession.userId,
          });
          authenticationMethodTypes = response.authMethodTypes ?? [];
        } catch {
          return { error: "Could not verify the account's remaining sign-in methods." };
        }

        const anotherPrimaryMethodRemains = authenticationMethodTypes.some(
          (method) => method === AuthenticationMethodType.PASSWORD || method === AuthenticationMethodType.IDP,
        );
        if (!anotherPrimaryMethodRemains) {
          return { error: "Add another sign-in method before removing this passkey." };
        }
      }

      try {
        await removePasskey({
          serviceConfig: managedSession.serviceConfig,
          userId: managedSession.userId,
          passkeyId,
        });
      } catch {
        return { error: "Could not remove this passkey." };
      }

      return { success: true };
    },
  );

  if ("error" in result) {
    return result;
  }

  revalidatePath("/passkey/set");
  return result;
}
