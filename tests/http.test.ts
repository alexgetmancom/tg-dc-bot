import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { createRuntimeStatus } from "../src/runtime/status.js";
import { migrateDatabase, openDatabase } from "../src/storage/database.js";

function buildApp() {
  const config = loadConfig({ BOT_MODE: "http-only", DATABASE_URL: ":memory:", APP_NAME: "demo" });
  const database = openDatabase(config.DATABASE_URL);
  migrateDatabase(database);
  return { app: createHttpApp(config, null, database, createRuntimeStatus(config.BOT_MODE)), database };
}

describe("HTTP app", () => {
  test("serves health and readiness", async () => {
    const { app, database } = buildApp();
    expect((await app.request("/healthz")).status).toBe(200);
    expect(await (await app.request("/healthz")).text()).toBe("ok\n");
    expect((await app.request("/readyz")).status).toBe(200);
    database.close();
  });

  test("returns the app name", async () => {
    const { app, database } = buildApp();
    expect(await (await app.request("/")).json()).toEqual({ name: "demo", status: "ok" });
    database.close();
  });

  test("reports a closed database as not ready", async () => {
    const { app, database } = buildApp();
    database.close();
    expect((await app.request("/readyz")).status).toBe(500);
  });
});
