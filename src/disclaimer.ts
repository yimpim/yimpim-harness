/**
 * The notice that goes with every security result. Gage's security checks are tools that help a person look; they are not
 * a guarantee, a certification or professional advice, and nothing they say (or fail to say) should be read as one.
 * One wording, used everywhere a result is shown or saved, so it cannot drift between them.
 */

/** One line, for console output and chat summaries. */
export const SECURITY_NOTICE_SHORT =
  "Automated, AI-assisted check: it can miss real problems and can be wrong. It is not a penetration test, audit or guarantee of security, and not professional advice. Have a qualified person review it before you rely on it or ship.";

/** The fuller text, for a saved report and the README. */
export const SECURITY_NOTICE_FULL = [
  "**Read this first.** This report was produced by automated tooling and AI models. It is a starting point for a person to review, not a guarantee of anything.",
  "- It can miss vulnerabilities, including serious ones. A result with no findings does not mean the application is secure.",
  "- It can report problems that are not real, and its suggested fixes can be wrong or incomplete. Check each one before acting on it.",
  "- It is not a penetration test, a security audit, a compliance assessment or professional advice, and it does not certify anything.",
  "- It is provided as is, without warranty of any kind. You are responsible for deciding what to do with it, and for having a qualified person review anything that matters before you rely on it or release it.",
  "- Only test systems you own or have written permission to test.",
].join("\n");
