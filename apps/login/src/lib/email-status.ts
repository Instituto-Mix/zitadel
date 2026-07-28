import { getUserByID, ServiceConfig } from "@/lib/zitadel";

/**
 * True when the signed-in user has an email that is not yet verified — i.e. a
 * pending action the /email page can resolve. Used to badge the Email nav link
 * across the post-login pages. Fail-soft: any error yields false.
 */
export async function isEmailPending(serviceConfig: ServiceConfig, userId: string | undefined): Promise<boolean> {
  if (!userId) {
    return false;
  }
  try {
    const userResponse = await getUserByID({ serviceConfig, userId });
    const human = userResponse?.user?.type.case === "human" ? userResponse.user.type.value : undefined;
    return !!human?.email?.email && !human.email.isVerified;
  } catch {
    return false;
  }
}
