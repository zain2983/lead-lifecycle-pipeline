// Preload (`NODE_OPTIONS=--require <this file>`): prints one line for every TLS upgrade node-postgres makes,
// with what Node decided about the server certificate. It changes no setting. Prints no host or user.
const tls = require("node:tls");
const connect = tls.connect;
tls.connect = function observed(...args) {
  const options = args[0] ?? {};
  const socket = connect.apply(this, args);
  // node-postgres upgrades an existing socket; anything else isn't a database connection.
  if (options.socket) {
    const settings = {
      rejectUnauthorized: options.rejectUnauthorized ?? "default(true)",
      customCa: Boolean(options.ca),
    };
    socket.once("secureConnect", () => {
      const line = {
        tls: socket.getProtocol(),
        certificateVerified: socket.authorized,
        ...settings,
      };
      process.stderr.write(`[tls] ${JSON.stringify(line)}\n`);
    });
    socket.once("error", (error) => {
      const line = { tlsFailed: error.code, ...settings };
      process.stderr.write(`[tls] ${JSON.stringify(line)}\n`);
    });
  }
  return socket;
};
