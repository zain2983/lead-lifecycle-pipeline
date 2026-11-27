// Operations CLI: `pnpm ops <command>`. Spike A adds `sweep --once`; Phase 4 adds `queues` and `replay`.
import { main } from "../ops/main.ts";

process.exitCode = await main(process.argv.slice(2));
