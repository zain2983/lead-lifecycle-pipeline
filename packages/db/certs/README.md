# Certificates

## `supabase-root.crt`

The root CA that signs the certificates of Supabase's database hosts. It is a public certificate.

|                                   |                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Subject (and issuer: self-signed) | `C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Root 2021 CA` ("Delware" is the certificate's own spelling) |
| SHA-256 fingerprint               | `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`                        |
| Valid                             | 2021-04-28 to **2031-04-26**                                                                                             |
| Downloaded from                   | `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt` (2026-11-28)                      |

Where the fingerprint matched, and the commands: [`docs/evidence/phase-1/supabase-tls/`](../../../docs/evidence/phase-1/supabase-tls/README.md).

`src/supabase-ca.ts` holds the same PEM for the app runtime; `test/tls.test.ts` fails if the two differ. To
replace the certificate, change both and the fingerprint here and in the test. Keep one certificate in this
file: Prisma's schema engine is reported to read only the first one in a bundle
([prisma/orm#31206](https://github.com/prisma/orm/issues/31206), not tested here).
