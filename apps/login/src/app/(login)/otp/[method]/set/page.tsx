import { Alert } from "@/components/alert";
import { BackButton } from "@/components/back-button";
import { DynamicTheme } from "@/components/dynamic-theme";
import { OTPAddForm } from "@/components/otp-add-form";
import { TotpRegister } from "@/components/totp-register";
import { Translated } from "@/components/translated";
import { UserAvatar } from "@/components/user-avatar";
import { getEnrollmentAuthorizationError } from "@/lib/server/enrollment-guard";
import { getServiceConfig } from "@/lib/server/service-url";
import { loadMostRecentSession, loadSessionById } from "@/lib/server/session";
import { getBrandingSettings, getLoginSettings, registerTOTP } from "@/lib/server/zitadel";
import { timestampDate } from "@zitadel/client";
import { Session } from "@zitadel/proto/zitadel/session/v2/session_pb";
import { SecondFactorType } from "@zitadel/proto/zitadel/settings/v2/login_settings_pb";
import { RegisterTOTPResponse } from "@zitadel/proto/zitadel/user/v2/user_service_pb";
import { headers } from "next/headers";

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

  // Bind every enrollment method to the selected signed-cookie session when present.
  const session = sessionId
    ? await loadSessionById(serviceConfig, sessionId, organization)
    : await loadMostRecentSession({
        serviceConfig,
        sessionParams: { loginName, organization },
      });

  if (
    method === "time-based" &&
    sessionId !== undefined &&
    (!session ||
      session.id !== sessionId ||
      (loginName !== undefined && loginName !== session.factors?.user?.loginName) ||
      (organization !== undefined && organization !== session.factors?.user?.organizationId))
  ) {
    throw new Error("The selected session does not match the requested account");
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
    // Enrollment must be authorized: a bare identify-only session must not be able to
    // attach a new OTP/TOTP factor to the account (GHSA-45f2-5q3r-xgg6).
    const enrollmentError = await getEnrollmentAuthorizationError({
      serviceConfig,
      session,
      userId: session.factors.user.id,
    });
    if (enrollmentError) {
      error = new Error(enrollmentError);
    } else if (method === "time-based") {
      // registering only creates a pending secret, which is not used for authentication until
      // the user verified a code from it, so it's safe to do while rendering
      await registerTOTP({ serviceConfig, userId: session.factors.user.id })
        .then((resp) => {
          if (resp) {
            totpResponse = resp;
          }
        })
        .catch((err) => {
          error = err;
        });
    } else if (method !== "sms" && method !== "email") {
      // OTP via SMS and email are only added on explicit confirmation of the user (see OTPAddForm),
      // never while rendering, so that a link alone can't change the second factors of a user
      throw new Error("Invalid method");
    }
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
  } else if (requestId?.startsWith("device_")) {
    // device flows are completed on the consent screen, never by navigating to /signedin
    paramsToContinue.append("requestId", requestId);
    urlToContinue = `/device/consent?` + paramsToContinue;
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
        ) : session && !error && (method === "email" || method === "sms") ? (
          <p className="ztdl-p">
            <Translated i18nKey={method === "email" ? "set.emailAddDescription" : "set.smsAddDescription"} namespace="otp" />
          </p>
        ) : null}

        {!session && (
          <div className="py-4">
            <Alert>
              {/* context was provided but the session could not be resolved (cookie missing, invalid or expired) */}
              <Translated i18nKey={loginName || sessionId ? "sessionExpired" : "unknownContext"} namespace="error" />
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
        ) : session && !error && (method === "email" || method === "sms") ? (
          <OTPAddForm
            method={method}
            sessionId={session.id}
            urlToContinue={urlToContinue}
            checkAfter={checkAfter === "true"}
          ></OTPAddForm>
        ) : (
          <div className="mt-8 flex w-full flex-row items-center">
            <BackButton />
          </div>
        )}
      </div>
    </DynamicTheme>
  );
}
