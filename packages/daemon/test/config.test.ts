import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { previewUrl, type Config } from "../src/config.js";

function config(partial: Partial<Config>): Config {
  return partial as Config;
}

describe("previewUrl", () => {
  it("builds a *.localhost subdomain on the proxy port", () => {
    assert.equal(
      previewUrl(config({ proxyPort: 4751 }), "abc123", 8080),
      "http://abc123-8080.localhost:4751/",
    );
  });

  it("keeps the sandbox id and port distinct in the label", () => {
    const url = previewUrl(config({ proxyPort: 9000 }), "deadbeef", 3000);
    assert.match(url, /^http:\/\/deadbeef-3000\.localhost:9000\/$/);
  });
});
