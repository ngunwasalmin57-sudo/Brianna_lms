import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function loadConfig(snippe: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "-e", "import('./src/config.ts')"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: "/dev/null",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
      JWT_SECRET: "unit-test-secret-that-is-at-least-thirty-two-characters",
      ...snippe,
    },
  });
}

test("Snippe remains disabled with no provider configuration and has no assumed endpoint", () => {
  const child = loadConfig();
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stdout + child.stderr, /api\.snippe\.sh/);
});

test("partial Snippe configuration fails with missing variable names", () => {
  const child = loadConfig({ SNIPPE_API_KEY: "test-key-only" });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /SNIPPE_BASE_URL/);
  assert.match(child.stderr, /SNIPPE_WEBHOOK_SECRET/);
  assert.match(child.stderr, /SNIPPE_WEBHOOK_URL/);
});

test("complete explicit HTTPS Snippe configuration is accepted", () => {
  const child = loadConfig({
    SNIPPE_BASE_URL: "https://provider-confirmed.example.test",
    SNIPPE_API_KEY: "test-key",
    SNIPPE_WEBHOOK_SECRET: "test-secret",
    SNIPPE_WEBHOOK_URL: "https://bml.example.test/api/webhooks/snippe",
  });
  assert.equal(child.status, 0, child.stderr);
});
