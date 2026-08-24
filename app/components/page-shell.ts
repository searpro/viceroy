/**
 * The one page-width container, shared by the nav and every screen under it.
 *
 * These had drifted: the nav is `max-w-5xl`, and five of the seven screens were
 * `max-w-3xl` — so on Providers, Styles, Preferences, the project page and the
 * home page, the content sat visibly indented from the nav above it while Jobs
 * and Prompts lined up. Each screen picked its own width at the time it was
 * written, and nothing tied them together.
 *
 * A shared constant rather than the same literal copied eight times, because
 * the copies are exactly what drifted. Anything that should line up with the
 * nav uses this and adds only its own vertical padding.
 */
export const PAGE_SHELL = "mx-auto w-full max-w-5xl px-6";
