import { describe, expect, it } from "vitest";
import { deterministicJobId, ID_NAMESPACE, uuidV5 } from "../src/ids.ts";

const DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const URL_NS = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

describe("uuidV5", () => {
  it("matches the reference implementation", () => {
    // Python: uuid.uuid5(uuid.NAMESPACE_DNS, "python.org")
    expect(uuidV5("python.org", DNS)).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
    expect(uuidV5("https://example.com/lead-lifecycle-pipeline", URL_NS)).toBe(ID_NAMESPACE);
  });

  it("rejects a namespace that is not a UUID", () => {
    expect(() => uuidV5("x", "not-a-uuid")).toThrowError(TypeError);
  });
});

describe("deterministicJobId", () => {
  it("is stable per key and differs across keys", () => {
    expect(deterministicJobId("contact-1:created")).toBe(deterministicJobId("contact-1:created"));
    expect(deterministicJobId("contact-1:created")).not.toBe(
      deterministicJobId("contact-2:created"),
    );
    expect(deterministicJobId("a")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses an empty key", () => {
    expect(() => deterministicJobId("")).toThrowError(TypeError);
  });
});
