import { describe, expect, it } from "vitest";
import { isReservedEmail } from "../src/reserved.ts";

describe("isReservedEmail (same rule as the lead_email_reserved_domain CHECK)", () => {
  it("accepts example.com/org/net and .test, with subdomains", () => {
    for (const email of [
      "a@example.com",
      "a@example.org",
      "a@mail.example.net",
      "a@quillmark.test",
      "qa+1@ops.harborlight.test",
    ]) {
      expect(isReservedEmail(email), email).toBe(true);
    }
  });

  it("rejects lookalikes, other reserved TLDs, upper case and real-looking domains", () => {
    for (const email of [
      "a@example.co",
      "a@notexample.com",
      "a@quillmark.invalid",
      "a@test",
      "A@EXAMPLE.COM",
      "someone@gmail.com",
      "",
    ]) {
      expect(isReservedEmail(email), email).toBe(false);
    }
  });
});
