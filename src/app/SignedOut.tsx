/**
 * Shown when there is no session and no dev actor.
 *
 * Deliberately states the product's claim rather than just offering a button:
 * this is the first thing on screen if a login fails during the demo, so it
 * should still say what Signet is.
 */
export function SignedOut() {
  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center gap-7 px-6 py-16">
      <div className="flex flex-col gap-3">
        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.13em] text-ink-faint">
          Signet
        </span>
        <h1 className="font-serif text-[2.25rem] leading-[1.1] tracking-[-0.015em] text-balance">
          Every dollar carries a <em className="not-italic text-accent">name</em>.
        </h1>
        <p className="max-w-[52ch] text-sm leading-relaxed text-ink-muted">
          An agent plans a project&rsquo;s spend, routes each line item to whoever holds authority
          over it, and executes the purchase under that approver&rsquo;s identity.
        </p>
      </div>

      <a
        href="/auth/login"
        className="inline-flex w-fit items-center rounded-sm bg-accent px-5 py-2.5 text-[0.8125rem] font-semibold text-white transition-transform active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Sign in
      </a>

      <p className="font-mono text-[0.6875rem] leading-relaxed text-ink-faint">
        No session. In development, set SIGNET_DEV_VIEWER_EMAIL to a seeded user to preview the
        interface before Auth0 logins work.
      </p>
    </main>
  );
}
