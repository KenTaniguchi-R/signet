/**
 * The approver's IP, recorded on the Issuing cardholder's terms acceptance.
 * Stripe requires a real value there or the cardholder lands in
 * `requirements.past_due` and can never back an active card.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? '127.0.0.1';
}
