import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";

export type { PrismaClient };

/**
 * Create a Prisma client on the pg driver adapter. Runtime code passes DATABASE_URL (the transaction
 * pooler in production); see docs/adr/0002-queue-and-db.md for the connection matrix.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}
