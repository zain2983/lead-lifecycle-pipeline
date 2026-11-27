// Operations CLI: `pnpm ops <command>`. Spike A adds `sweep --once`; Phase 4 adds `queues` and `replay`.
const [command] = process.argv.slice(2);
console.error(`ops: unknown command ${command ?? "(none)"}`);
process.exitCode = 1;
