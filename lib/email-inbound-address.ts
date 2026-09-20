/**
 * Client-safe helpers for the unique forward-to address.
 * Keep in sync with lib/email-inbound.ts server helpers.
 */

export function getPublicEmailInboundDomain(): string {
  if (typeof process !== 'undefined') {
    return (
      process.env.NEXT_PUBLIC_EMAIL_INBOUND_DOMAIN?.trim() ||
      process.env.EMAIL_INBOUND_DOMAIN?.trim() ||
      'inbound.estimateace.com'
    );
  }
  return 'inbound.estimateace.com';
}

export function getInboundAddressForUserClient(userId: string): string {
  const hex = String(userId || '')
    .replace(/-/g, '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
  if (hex.length < 32) return '';
  return `u${hex.slice(0, 32)}@${getPublicEmailInboundDomain()}`;
}
