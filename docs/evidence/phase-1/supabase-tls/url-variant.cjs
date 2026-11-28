// Prints a variant of the URL in $<name> for a negative test. Capture it with $(...); never echo it.
//   node url-variant.cjs DIRECT_URL no-sslmode
//   node url-variant.cjs DIRECT_URL wrong-ca <ca.crt>       an unrelated CA
//   node url-variant.cjs DIRECT_URL wrong-host <ca.crt>     the right CA, but connecting by IP address
const dns = require("node:dns/promises");
const [name, variant, ca] = process.argv.slice(2);
(async () => {
  const url = new URL(process.env[name]);
  if (variant === "no-sslmode") url.search = "";
  if (variant === "wrong-ca" || variant === "wrong-host") url.searchParams.set("sslrootcert", ca);
  if (variant === "wrong-host")
    url.hostname = (await dns.lookup(url.hostname, { family: 4 })).address;
  process.stdout.write(url.toString());
})();
