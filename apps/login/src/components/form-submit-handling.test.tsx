import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A form whose submit handler lives ONLY on the button's onClick is submitted
 * natively when the user presses Enter in a field: onClick never fires, nothing
 * calls preventDefault, and the browser performs the form's default GET —
 * putting every field, INCLUDING THE PASSWORD, into the query string. From there
 * it reaches the URL bar, browser history, the Referer header and the server
 * access log. The flow also silently does not submit, so the user sees the form
 * again with no error.
 *
 * Observed for real on /password/first-access before this was fixed:
 *   /password/first-access?password=EnterLeak%402026x&confirmPassword=EnterLeak%402026x
 *
 * The fix is to put the handler on the form's onSubmit, which covers both Enter
 * and the click, and to REMOVE the button's onClick — with onSubmit present, a
 * click would otherwise run the handler twice and double-submit. For first
 * access that would mean two password-set attempts against a single-use reset
 * code, so the duplicate is not merely wasteful.
 */
const COMPONENTS_DIR = path.join(__dirname);

function componentFiles(): string[] {
  return fs
    .readdirSync(COMPONENTS_DIR)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => path.join(COMPONENTS_DIR, f));
}

type Form = { file: string; source: string };

/**
 * Scoped to forms that carry a PASSWORD field. Seven further forms share the same
 * shape with non-password fields (device-code, login-otp, register-form,
 * register-form-idp-incomplete, register-passkey, totp-register, verify-form) and
 * leak codes/usernames the same way — the same defect, lower severity, and
 * pre-existing upstream. They are deliberately not asserted here rather than
 * silently widening tonight's change to flows that were not retested.
 */
function passwordFormsWithASubmitButton(): Form[] {
  return componentFiles()
    .map((file) => ({ file, source: fs.readFileSync(file, "utf8") }))
    .filter(
      ({ source }) => source.includes("<form") && source.includes('type="submit"') && source.includes('type="password"'),
    );
}

describe("forms containing a password field", () => {
  const forms = passwordFormsWithASubmitButton();

  it("finds the forms to check", () => {
    expect(forms.length).toBeGreaterThanOrEqual(6);
  });

  it.each(forms.map((f) => [path.basename(f.file), f] as const))(
    "%s handles submission on the form, so Enter cannot leak fields into the URL",
    (_name, form) => {
      expect(form.source).toContain("onSubmit");
    },
  );

  // Belt and braces: a handler on BOTH onSubmit and the submit button's onClick
  // runs twice per click. For first access that is two attempts against a
  // single-use reset code.
  it.each(forms.map((f) => [path.basename(f.file), f] as const))(
    "%s does not also bind handleSubmit to the submit button's onClick",
    (_name, form) => {
      expect(form.source).not.toMatch(/onClick=\{handleSubmit/);
    },
  );
});
