// pnpm --filter @repo/db erd [--check]
//
// Renders packages/db/prisma/schema.prisma as a Mermaid ER diagram and writes it into the repo README
// between the `erd:start` and `erd:end` markers. `--check` writes nothing and exits 1 if the README is
// stale (test/erd.test.ts does the same check in CI).
//
// A small parser instead of a generator package: prisma-erd-generator renders through mermaid-cli and
// Puppeteer (a Chromium download), and this schema only uses plain model, enum and @relation syntax.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ERD_START = "<!-- erd:start -->";
export const ERD_END = "<!-- erd:end -->";

interface Field {
  name: string;
  type: string;
  optional: boolean;
  list: boolean;
  attributes: string;
}

interface Model {
  name: string;
  fields: Field[];
  /** Field-name lists from @@unique. */
  uniques: string[][];
}

interface Schema {
  models: Model[];
  enums: Map<string, string[]>;
}

const BLOCK = /^(model|enum)\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

export function parseSchema(text: string): Schema {
  const models: Model[] = [];
  const enums = new Map<string, string[]>();
  for (const [, kind, name, body] of text.matchAll(BLOCK)) {
    if (!name || body === undefined) continue;
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//"));
    if (kind === "enum") {
      enums.set(
        name,
        lines.filter((line) => !line.startsWith("@@")).map((line) => line.split(/\s+/)[0] ?? ""),
      );
      continue;
    }
    const model: Model = { name, fields: [], uniques: [] };
    for (const line of lines) {
      if (line.startsWith("@@unique")) {
        const inner = /\[([^\]]*)\]/.exec(line)?.[1] ?? "";
        model.uniques.push(inner.split(",").map((part) => part.trim()));
        continue;
      }
      if (line.startsWith("@@")) continue;
      const match = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!match) throw new Error(`erd: can't parse field in model ${name}: ${line}`);
      const [, fieldName = "", type = "", list, optional, attributes = ""] = match;
      model.fields.push({
        name: fieldName,
        type,
        list: list !== undefined,
        optional: optional !== undefined,
        attributes,
      });
    }
    models.push(model);
  }
  return { models, enums };
}

function isUnique(model: Model, fieldNames: string[]): boolean {
  if (fieldNames.length === 1) {
    const field = model.fields.find((f) => f.name === fieldNames[0]);
    if (field && /@unique\b|@id\b/.test(field.attributes)) return true;
  }
  return model.uniques.some(
    (unique) => unique.length === fieldNames.length && unique.every((n) => fieldNames.includes(n)),
  );
}

export function renderErd(text: string): string {
  const { models, enums } = parseSchema(text);
  const modelNames = new Set(models.map((model) => model.name));
  const lines = ["```mermaid", "erDiagram"];
  const relations: string[] = [];

  for (const model of models) {
    lines.push(`  ${model.name} {`);
    const fkFields = new Set<string>();
    for (const field of model.fields) {
      if (!modelNames.has(field.type)) continue;
      const relation = /@relation\(([^)]*)\)/.exec(field.attributes)?.[1];
      const fields = relation && /fields:\s*\[([^\]]*)\]/.exec(relation)?.[1];
      if (!fields) continue; // the other side of a relation: drawn from the model that holds the FK
      const fkNames = fields.split(",").map((part) => part.trim());
      for (const fk of fkNames) fkFields.add(fk);
      const parentSide = field.optional ? "|o" : "||";
      const childSide = isUnique(model, fkNames) ? "o|" : "o{";
      relations.push(
        `  ${field.type} ${parentSide}--${childSide} ${model.name} : "${fkNames.join(", ")}"`,
      );
    }
    for (const field of model.fields) {
      if (modelNames.has(field.type)) continue;
      const keys: string[] = [];
      if (/@id\b/.test(field.attributes)) keys.push("PK");
      if (fkFields.has(field.name)) keys.push("FK");
      if (/@unique\b/.test(field.attributes)) keys.push("UK");
      const type = `${field.type}${field.list ? "[]" : ""}`;
      const key = keys.length > 0 ? ` ${keys.join(", ")}` : "";
      const comment = field.optional ? ' "nullable"' : "";
      lines.push(`    ${type} ${field.name}${key}${comment}`);
    }
    lines.push("  }");
  }
  lines.push(...relations, "```");

  if (enums.size > 0) {
    // A list, not a table: Biome pads Markdown tables, and the README must stay byte-equal to this output.
    lines.push("", "Enums:", "");
    for (const [name, values] of enums) {
      lines.push(`- \`${name}\`: ${values.map((value) => `\`${value}\``).join(" · ")}`);
    }
  }
  return lines.join("\n");
}

/** The README with its ERD block replaced. Throws if the markers are missing. */
export function withErd(readme: string, erd: string): string {
  const start = readme.indexOf(ERD_START);
  const end = readme.indexOf(ERD_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README has no ${ERD_START} … ${ERD_END} block`);
  }
  return `${readme.slice(0, start + ERD_START.length)}\n${erd}\n${readme.slice(end)}`;
}

export const SCHEMA_PATH = path.resolve(import.meta.dirname, "../prisma/schema.prisma");
export const README_PATH = path.resolve(import.meta.dirname, "../../../README.md");

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const readme = readFileSync(README_PATH, "utf8");
  const next = withErd(readme, renderErd(readFileSync(SCHEMA_PATH, "utf8")));
  if (process.argv.includes("--check")) {
    if (next !== readme) {
      console.error("README.md ERD is stale: run `pnpm --filter @repo/db erd`");
      process.exit(1);
    }
    console.log("README.md ERD is up to date");
  } else if (next === readme) {
    console.log("README.md ERD unchanged");
  } else {
    writeFileSync(README_PATH, next);
    console.log("README.md ERD updated");
  }
}
