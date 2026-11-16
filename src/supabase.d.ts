/**
 * Ambient fallback for `@supabase/supabase-js`.
 *
 * The broker imports the package dynamically (`await import("@supabase/supabase-js")`)
 * and degrades gracefully when it is absent, so the CLI must still typecheck on a
 * machine where the package has not been installed yet. Without this declaration
 * `tsc --noEmit` fails with TS2307 at the dynamic import site.
 *
 * Once the real package is installed its own types win for `import` statements —
 * this shorthand module only fills the gap for unresolved module specifiers.
 */
declare module "@supabase/supabase-js";
