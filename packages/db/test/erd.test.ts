import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { README_PATH, renderErd, SCHEMA_PATH, withErd } from "../scripts/erd.ts";

describe("README ERD", () => {
  it("matches the Prisma schema (run `pnpm --filter @repo/db erd` after a schema change)", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(withErd(readme, renderErd(readFileSync(SCHEMA_PATH, "utf8")))).toBe(readme);
  });

  it("draws a relation from the model that holds the foreign key, with its cardinality", () => {
    const erd = renderErd(`
model Parent {
  id   String  @id
  kids Kid[]
  pet  Pet?
}
model Kid {
  id       String  @id
  parentId String? @map("parent_id")
  parent   Parent? @relation(fields: [parentId], references: [id])
}
model Pet {
  id       String @id
  parentId String @unique
  parent   Parent @relation(fields: [parentId], references: [id])
}
enum Colour {
  red
  blue
  @@map("colour")
}
`);
    expect(erd).toContain('Parent |o--o{ Kid : "parentId"');
    expect(erd).toContain('Parent ||--o| Pet : "parentId"');
    expect(erd).toContain('String parentId FK "nullable"');
    expect(erd).toContain("String parentId FK, UK");
    expect(erd).toContain("- `Colour`: `red` · `blue`");
    expect(erd).not.toMatch(/Kid\[\] kids/);
  });
});
