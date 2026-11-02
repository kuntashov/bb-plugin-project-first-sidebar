import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";

it("uses only declared public dependencies and package-local source", () => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const allow = names.map((name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`));
  allow.push(/^@\/(?:components|lib)\//);
  const result = experimental_scanPublicSdkOnly(root, { allow });
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
  for (const value of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) {
    expect(value).not.toMatch(/^(?:workspace:|file:|link:|\/)/);
  }
  expect(manifest.name).toBe("bb-plugin-project-first-sidebar");
});
