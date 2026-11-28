// stdin -> stdout with the hosts, users, project ref, passwords and IP addresses of $DATABASE_URL and
// $DIRECT_URL replaced.
const secrets = [];
for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
  if (!process.env[name]) continue;
  const url = new URL(process.env[name]);
  const user = decodeURIComponent(url.username);
  secrets.push([decodeURIComponent(url.password), "<password>"], [url.password, "<password>"]);
  secrets.push([url.hostname, "<host>"], [user, "<user>"], [user.split(".")[1], "<ref>"]);
}
let text = "";
process.stdin.on("data", (chunk) => {
  text += chunk;
});
process.stdin.on("end", () => {
  for (const [value, label] of secrets) if (value) text = text.split(value).join(label);
  text = text
    .replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>")
    .replace(/[a-z0-9.-]+\.supabase\.(com|co)/gi, "<host>")
    .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, "<ip>")
    .replace(/\/Users\/[^\s"']*?\/live-a\//g, "<repo>/");
  process.stdout.write(text);
});
