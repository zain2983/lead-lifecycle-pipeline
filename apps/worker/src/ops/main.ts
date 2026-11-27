import { parseSweepArgs, runSweep, type SweepArgs, USAGE } from "./sweep.ts";

/** `pnpm ops <command>`: returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "sweep") {
    let args: SweepArgs;
    try {
      args = parseSweepArgs(rest);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      return 2;
    }
    return (await runSweep(args)) ? 0 : 1;
  }
  console.error(`ops: unknown command ${command ?? "(none)"}\n\n${USAGE}`);
  return 2;
}
