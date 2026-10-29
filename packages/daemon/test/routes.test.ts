import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ROUTES as API_ROUTES } from "../../sdk/src/generated/routes.js";
import {
  ROUTES,
  buildPath,
  matchPath,
  matchRoute,
  routeById,
  routeParams,
} from "../src/api/routes.js";

/** Canonicalise a path template so `{id}` and `{p}` compare equal. */
function canonical(path: string): string {
  return path.replace(/\{[^}]*\}/g, "{}");
}

describe("route table", () => {
  it("has no duplicate method + path pairs", () => {
    const seen = new Set<string>();
    for (const route of ROUTES) {
      const key = `${route.method} ${route.path}`;
      assert.ok(!seen.has(key), `duplicate route: ${key}`);
      seen.add(key);
    }
  });

  it("has unique operation ids", () => {
    const ids = ROUTES.map((route) => route.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("round-trips every route through buildPath and matchRoute", () => {
    for (const route of ROUTES) {
      const params: Record<string, string | number> = {};
      for (const name of routeParams(route)) {
        params[name] = route.path.includes(`{${name}:int}`) ? 8080 : `value-${name}`;
      }
      const path = buildPath(route.id, params);
      const match = matchRoute(route.method, path);
      assert.ok(match, `${route.id}: ${route.method} ${path} did not match`);
      assert.equal(match.route.id, route.id);
      assert.deepEqual(match.params, Object.fromEntries(
        Object.entries(params).map(([key, value]) => [key, String(value)]),
      ));
    }
  });

  it("rejects a non-numeric value for an int param", () => {
    assert.equal(matchRoute("DELETE", "/sandboxes/abc/expose/not-a-port"), undefined);
    assert.ok(matchRoute("DELETE", "/sandboxes/abc/expose/8080"));
  });

  it("returns undefined for unknown routes", () => {
    assert.equal(matchRoute("GET", "/nope"), undefined);
    assert.equal(matchRoute("PUT", "/sandboxes"), undefined);
    assert.equal(matchRoute("GET", "/sandboxes/abc/files/delete"), undefined);
  });

  it("throws on an unknown route id or a missing param", () => {
    assert.throws(() => routeById("nope"), /unknown route id/);
    assert.throws(() => buildPath("sandboxes.exec"), /missing path param "id"/);
  });

  it("keeps health, info and the dashboard open; everything else authenticated", () => {
    const open = ROUTES.filter((route) => !route.auth).map((route) => route.id).sort();
    assert.deepEqual(open, ["dashboard", "dashboard.alias", "healthz", "info"]);
  });

  it("every route has a dispatch case in the daemon", () => {
    const source = readFileSync(new URL("../src/api/server.ts", import.meta.url), "utf8");
    const cases = new Set([...source.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
    const missing = ROUTES.map((route) => route.id).filter((id) => !cases.has(id));
    assert.deepEqual(missing, [], `routes without a handler: ${missing.join(", ")}`);
  });

  it("normalises span names to the documented template", () => {
    assert.equal(matchPath("/sandboxes/abc123")?.path, "/sandboxes/{id}");
    assert.equal(matchPath("/sandboxes/abc123/exec")?.path, "/sandboxes/{id}/exec");
    assert.equal(matchPath("/sandboxes/abc123/files/write")?.path, "/sandboxes/{id}/files/write");
  });
});

describe("generated clients", () => {
  it("TypeScript route table matches the daemon table", () => {
    assert.deepEqual(
      Object.keys(API_ROUTES).sort(),
      ROUTES.map((route) => route.id).sort(),
    );
    for (const route of ROUTES) {
      const generated = API_ROUTES[route.id as keyof typeof API_ROUTES];
      assert.equal(generated.method, route.method, route.id);
      assert.equal(generated.path, route.path, route.id);
      assert.equal(generated.auth, route.auth, route.id);
    }
  });

  it("every path literal in the TS and Python SDKs is a known route", () => {
    const known = new Set(ROUTES.map((route) => canonical(route.path)));
    const sources = [
      new URL("../../sdk/src/index.ts", import.meta.url),
      new URL("../../../sdk/python/hotcell/__init__.py", import.meta.url),
    ];
    const prefixes = [
      "/sandboxes",
      "/templates",
      "/backups",
      "/healthz",
      "/info",
      "/capacity",
      "/traces",
      "/reload-keys",
      "/audit-events",
      "/dashboard",
    ];
    const unknown: string[] = [];
    for (const source of sources) {
      const text = readFileSync(source, "utf8");
      for (const match of text.matchAll(/(["'`])(\/[^\n]*?)\1/g)) {
        const literal = match[2];
        if (!prefixes.some((prefix) => literal === prefix || literal.startsWith(`${prefix}/`))) {
          continue;
        }
        const normalised = canonical(literal.replace(/\$\{[^}]*\}/g, "{}"));
        if (!known.has(normalised)) unknown.push(`${source.pathname}: ${literal}`);
      }
    }
    assert.deepEqual(unknown, [], `SDK paths missing from the route table:\n${unknown.join("\n")}`);
  });
});
