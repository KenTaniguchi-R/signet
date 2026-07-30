import type { Role } from '@/db';

/**
 * A signet: a monogram pressed into a ring.
 *
 * Role is carried by the seal rather than a coloured chip because the seal is
 * the product's own metaphor, and because a monogram reads at three metres on a
 * projector where a small pill does not. The ink is role-tinted so two browser
 * windows running as two different people separate at a glance.
 */

export const SEAL_INK: Record<Role, string> = {
  finance: 'text-seal-finance',
  legal: 'text-seal-legal',
  ops: 'text-seal-ops',
  member: 'text-ink-muted',
};

export const ROLE_LABEL: Record<Role, string> = {
  finance: 'Finance',
  legal: 'Legal',
  ops: 'Ops lead',
  member: 'Member',
};

function initialsOf(displayName: string): string {
  return displayName
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function Seal({
  displayName,
  role,
  size = 'md',
}: {
  displayName: string;
  role: Role;
  size?: 'sm' | 'md';
}) {
  const box = size === 'sm' ? 'h-7 w-7 text-[0.6875rem]' : 'h-[46px] w-[46px] text-[0.9375rem]';

  return (
    <span
      aria-hidden="true"
      className={`${box} ${SEAL_INK[role]} grid shrink-0 place-items-center rounded-full border-[1.5px] border-current font-serif tracking-[0.04em] shadow-[inset_0_0_0_3px_var(--color-surface),inset_0_0_0_4px_currentColor]`}
    >
      {initialsOf(displayName)}
    </span>
  );
}
