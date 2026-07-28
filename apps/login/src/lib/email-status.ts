import { usableEmail } from "@/lib/placeholder-email";
import { getUserByID, ServiceConfig } from "@/lib/zitadel";

/**
 * True when the signed-in user has an email action outstanding — i.e. something
 * the /email page can resolve. Used to badge the Email nav link across the
 * post-login pages. Fail-soft: any error yields false.
 *
 * Two cases count as pending:
 *  - no usable address on file (missing, or the undeliverable provisioning
 *    placeholder). These users need to ADD an address; without one they have no
 *    password recovery channel at all, so the nag matters most here.
 *  - a real address that has not been verified yet.
 */
export async function isEmailPending(serviceConfig: ServiceConfig, userId: string | undefined): Promise<boolean> {
  if (!userId) {
    return false;
  }
  try {
    const userResponse = await getUserByID({ serviceConfig, userId });
    const human = userResponse?.user?.type.case === "human" ? userResponse.user.type.value : undefined;
    const email = usableEmail(human?.email?.email);
    return !email || !human?.email?.isVerified;
  } catch {
    return false;
  }
}
