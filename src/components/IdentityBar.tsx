import Link from 'next/link';

import type { Actor } from '@/lib/actor';

import { ROLE_LABEL, SEAL_INK, Seal } from './Seal';

/**
 * The single most important element in the build.
 *
 * The claim being demonstrated is "a different person approved, and the money
 * moved under their name". Two browser windows prove that only if a judge can
 * tell them apart instantly, so the name is set large in the serif and the seal
 * carries role ink.
 */
export function IdentityBar({
  actor,
  active,
  inboxCount,
}: {
  actor: Actor;
  active: 'plan' | 'inbox';
  inboxCount: number;
}) {
  return (
    <header className="flex items-center gap-4 border-b border-rule bg-surface px-5 py-3.5">
      <Seal displayName={actor.displayName} role={actor.role} />

      <div className="min-w-0">
        <div className="truncate font-serif text-[1.3125rem] leading-tight tracking-[-0.01em]">
          {actor.displayName}
        </div>
        <div className="mt-0.5 flex items-center gap-2.5">
          <span
            className={`${SEAL_INK[actor.role]} font-mono text-[0.6875rem] uppercase tracking-[0.13em]`}
          >
            {ROLE_LABEL[actor.role]}
          </span>
          <span className="text-[0.8125rem] text-ink-faint">{actor.email}</span>
        </div>
      </div>

      <nav className="ml-auto flex gap-1">
        <NavLink href="/" label="Plan" isActive={active === 'plan'} />
        <NavLink
          href="/inbox"
          label={inboxCount > 0 ? `Inbox ${inboxCount}` : 'Inbox'}
          isActive={active === 'inbox'}
        />
      </nav>
    </header>
  );
}

function NavLink({ href, label, isActive }: { href: string; label: string; isActive: boolean }) {
  return (
    <Link
      href={href}
      aria-current={isActive ? 'page' : undefined}
      className={
        isActive
          ? 'rounded-sm bg-accent-tint px-2.5 py-1.5 text-[0.8125rem] font-semibold text-accent'
          : 'rounded-sm px-2.5 py-1.5 text-[0.8125rem] text-ink-muted transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
      }
    >
      {label}
    </Link>
  );
}
