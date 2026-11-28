/**
 * Reserved email domains, the same rule as the `lead_email_reserved_domain` CHECK constraint: RFC 2606's
 * `example.com/org/net` (and subdomains) and RFC 6761's `.test`. The repo stores no other email
 * (synthetic data only), so code checks this before writing, and the database refuses the rest.
 * Expects a lower-cased address (the database also requires lower case).
 */
export const RESERVED_EMAIL =
  /^[^@\s]+@((([a-z0-9-]+\.)*example\.(com|org|net))|(([a-z0-9-]+\.)+test))$/;

export function isReservedEmail(email: string): boolean {
  return RESERVED_EMAIL.test(email);
}
