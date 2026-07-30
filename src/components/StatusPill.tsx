const TONE = {
  ok: 'text-ok bg-ok-tint',
  halt: 'text-halt bg-halt-tint ring-1 ring-halt/30',
  stop: 'text-stop bg-stop-tint',
  idle: 'text-ink-muted bg-surface-2',
} as const;

export type PillTone = keyof typeof TONE;

/**
 * State is encoded in form as well as colour: every pill carries a square
 * severity mark. A projector with bad colour calibration still resolves the
 * difference, and so does a colour-blind judge.
 */
export function StatusPill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  return (
    <span
      className={`${TONE[tone]} inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm px-2 py-0.5 font-mono text-[0.6875rem] uppercase tracking-[0.09em]`}
    >
      <span aria-hidden="true" className="h-[5px] w-[5px] rounded-[1px] bg-current" />
      {children}
    </span>
  );
}
