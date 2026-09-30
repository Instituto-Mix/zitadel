import { Alert } from "@/components/alert";
import { BackButton } from "@/components/back-button";
import { Button, ButtonVariants } from "@/components/button";
import { DynamicTheme } from "@/components/dynamic-theme";
import { TotpRegister } from "@/components/totp-register";
import { Translated } from "@/components/translated";
import { UserAvatar } from "@/components/user-avatar";
import { getSessionCookieById } from "@/lib/cookies";
import { getServiceConfig } from "@/lib/service-url";
import { loadMostRecentSession } from "@/lib/session";
import { addOTPEmail, addOTPSMS, getBrandingSettings, getLoginSettings, getSession, registerTOTP } from "@/lib/zitadel";
import { timestampDate } from "@zitadel/client";
import { Session } from "@zitadel/proto/zitadel/session/v2/session_pb";
import { SecondFactorType } from "@zitadel/proto/zitadel/settings/v2/login_settings_pb";
import { RegisterTOTPResponse } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

function isSessionValidForTOTPSetup(session: Session): boolean {
  const hasVerifiedFactor = Boolean(
    session.factors?.password?.verifiedAt ||
    (session.factors?.webAuthN?.verifiedAt && session.factors?.webAuthN?.userVerified) ||
    session.factors?.intent?.verifiedAt,
  );
  const isUnexpired = !session.expirationDate || timestampDate(session.expirationDate) > new Date();

  return hasVerifiedFactor && isUnexpired;
}

export default async function Page(props: {
  searchParams: Promise<Record<string | number | symbol, string | undefined>>;
  params: Promise<Record<string | number | symbol, string | undefined>>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;

  const { loginName, organization, sessionId, requestId, checkAfter } = searchParams;
  const { method } = params;

  const _headers = await headers();
  const { serviceConfig } = getServiceConfig(_headers);

  let session: Session | undefined;
  if (method === "time-based" && sessionId !== undefined) {
    const sessionCookie = await getSessionCookieById({ sessionId });
    if (!sessionCookie) {
      throw new Error("No selected session found");
    }

    const sessionResponse = await getSession({
      serviceConfig,
      sessionId: sessionCookie.id,
      sessionToken: sessionCookie.token,
    });
    session = sessionResponse.session;

    if (
      !session ||
      session.id !== sessionId ||
      (loginName !== undefined && loginName !== session.factors?.user?.loginName) ||
      (organization !== undefined && organization !== session.factors?.user?.organizationId)
    ) {
      throw new Error("The selected session does not match the requested account");
    }
  } else {
    session = await loadMostRecentSession({
      serviceConfig,
      sessionParams: {
        loginName,
        organization,
      },
    });
  }

  if (method === "time-based" && (!session || !session.factors?.user?.id || !isSessionValidForTOTPSetup(session))) {
    throw new Error("A valid authenticated session is required to set up an authenticator");
  }

  const accountOrganization = method === "time-based" ? session?.factors?.user?.organizationId : organization;
  const branding = await getBrandingSettings({ serviceConfig, organization: accountOrganization });
  const loginSettings = await getLoginSettings({ serviceConfig, organization: accountOrganization });

  if (method === "time-based" && !loginSettings?.secondFactors?.includes(SecondFactorType.OTP)) {
    throw new Error("Authenticator app setup is not allowed by the login policy");
  }

  let totpResponse: RegisterTOTPResponse | undefined, error: Error | undefined;
  if (session && session.factors?.user?.id) {
    if (method === "time-based") {
      await registerTOTP({ serviceConfig, userId: session.factors.user.id })
        .then((resp) => {
          if (resp) {
            totpResponse = resp;
          }
        })
        .catch((err) => {
          error = err;
        });
    } else if (method === "sms") {
      await addOTPSMS({ serviceConfig, userId: session.factors.user.id }).catch((_error) => {
        // TODO: Throw this error?
        new Error("Could not add OTP via SMS");
      });
    } else if (method === "email") {
      await addOTPEmail({ serviceConfig, userId: session.factors.user.id }).catch((_error) => {
        // TODO: Throw this error?
        new Error("Could not add OTP via Email");
      });
    } else {
      throw new Error("Invalid method");
    }
  } else {
    throw new Error("No session found");
  }

  const paramsToContinue = new URLSearchParams({});
  let urlToContinue = "/accounts";

  if (sessionId) {
    paramsToContinue.append("sessionId", sessionId);
  }
  if (loginName) {
    paramsToContinue.append("loginName", loginName);
  }
  if (organization) {
    paramsToContinue.append("organization", organization);
  }

  if (checkAfter) {
    if (requestId) {
      paramsToContinue.append("requestId", requestId);
    }
    urlToContinue = `/otp/${method}?` + paramsToContinue;

    // immediately check the OTP on the next page if sms or email was set up
    if (["email", "sms"].includes(method)) {
      return redirect(urlToContinue);
    }
  } else if (requestId && sessionId) {
    if (requestId) {
      paramsToContinue.append("authRequest", requestId);
    }
    urlToContinue = `/login?` + paramsToContinue;
  } else if (loginName) {
    if (requestId) {
      paramsToContinue.append("requestId", requestId);
    }
    urlToContinue = `/signedin?` + paramsToContinue;
  }

  return (
    <DynamicTheme branding={branding}>
      <div className="flex flex-col space-y-4">
        <h1>
          <Translated i18nKey="set.title" namespace="otp" />
        </h1>

        {totpResponse && "uri" in totpResponse && "secret" in totpResponse ? (
          <p className="ztdl-p">
            <Translated i18nKey="set.totpRegisterDescription" namespace="otp" />
          </p>
        ) : (
          <p className="ztdl-p">
            {method === "email"
              ? "Code via email was successfully added."
              : method === "sms"
                ? "Code via SMS was successfully added."
                : ""}
          </p>
        )}

        {!session && (
          <div className="py-4">
            <Alert>
              <Translated i18nKey="unknownContext" namespace="error" />
            </Alert>
          </div>
        )}

        {error && (
          <div className="py-4">
            <Alert>{error?.message}</Alert>
          </div>
        )}

        {session && (
          <UserAvatar
            loginName={loginName ?? session.factors?.user?.loginName}
            displayName={session.factors?.user?.displayName}
            showDropdown
            searchParams={searchParams}
          ></UserAvatar>
        )}
      </div>

      <div className="w-full">
        {totpResponse && "uri" in totpResponse && "secret" in totpResponse ? (
          <div>
            <TotpRegister
              uri={totpResponse.uri as string}
              secret={totpResponse.secret as string}
              loginName={loginName}
              sessionId={sessionId}
              requestId={requestId}
              organization={organization}
              checkAfter={checkAfter === "true"}
              loginSettings={loginSettings}
            ></TotpRegister>
          </div>
        ) : (
          <div className="mt-8 flex w-full flex-row items-center">
            <BackButton />
            <span className="flex-grow"></span>

            <Link href={urlToContinue}>
              <Button type="submit" className="self-end" variant={ButtonVariants.Primary}>
                <Translated i18nKey="set.submit" namespace="otp" />
              </Button>
            </Link>
          </div>
        )}
      </div>
    </DynamicTheme>
  );
}
