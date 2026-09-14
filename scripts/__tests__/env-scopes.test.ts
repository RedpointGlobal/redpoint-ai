/**
 * env-scopes — the security guard for per-artifact environment scoping. Pure
 * parse→emit→check logic, so this is the full matrix with no filesystem/live
 * deps. The highest-value cases are the leak guards (plant a secret → build MUST
 * fail) and the exact-key-set + absence assertions on the shipped templates.
 */
import { describe, it, expect } from "bun:test";
import {
  parseScopedEnv,
  renderEnvExample,
  renderBinaryTemplate,
  sliceForScope,
  runBuildCheck,
  parseArtifactKV,
  sensitiveValuesFrom,
  SECRET_KEYS,
  checkComposeEnv,
  COMPOSE_OVERRIDE_KEYS,
} from "../env-scopes";

// A representative fixture mirroring the real root .env structure (22 vars).
const FIXTURE = `#@scope: hosted-app, mcp-rpi, mcp-drh
# universal gate
AUTH_REQUIRED=true

#@scope: hosted-app
# jwt secret
AUTH_SECRET=REAL_SECRET_abc123
# llm key
AZURE_OPENAI_API_KEY=REAL_AZURE_KEY_xyz
# resource
AZURE_OPENAI_RESOURCE_NAME=fake-openai-resource
AZURE_OPENAI_DEPLOYMENT_ID=gpt-4.1
AZURE_OPENAI_API_VERSION=2024-10-01-preview
INSTRUMENTATION_ENABLED=true
INSTRUMENTATION_USER_ID=real.person@company.com

#@scope: container
# compose only
COMPOSE_PROJECT_NAME=redpointai

#@scope: hosted-app, mcp-rpi
RPI_INTEGRATION_API_URL=https://real-tenant.vendorcdp.com/
RPI_OAUTH_CLIENT_ID=realclientid
RPI_OAUTH_CLIENT_SECRET=REAL_RPI_SECRET_9999
RPI_DEFAULT_CLIENT_ID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
RPI_URL_ALLOWLIST=vendorcdp.com

#@scope: mcp-rpi
RPI_PROXY_ENABLED=true
RPI_PROXY_USER=fake-proxy-user
RPI_PROXY_PASS=REAL_RPI_PROXY_PW

#@scope: hosted-app, mcp-drh
DRH_API_URL=https://real-tenant-web.vendorcdp.com/

#@scope: mcp-drh
DRH_DEFAULT_CLIENT_ID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
DRH_DEFAULT_DATABASE_ID=1
DRH_PROXY_ENABLED=true
DRH_PROXY_USER=drh-proxy@noemail.com
DRH_PROXY_PASS=REAL_DRH_PROXY_PW
`;

const RPI_KEYS = [
  "AUTH_REQUIRED",
  "RPI_INTEGRATION_API_URL",
  "RPI_OAUTH_CLIENT_ID",
  "RPI_OAUTH_CLIENT_SECRET",
  "RPI_DEFAULT_CLIENT_ID",
  "RPI_URL_ALLOWLIST",
  "RPI_PROXY_ENABLED",
  "RPI_PROXY_USER",
  "RPI_PROXY_PASS",
];
const DRH_KEYS = [
  "AUTH_REQUIRED",
  "DRH_API_URL",
  "DRH_DEFAULT_CLIENT_ID",
  "DRH_DEFAULT_DATABASE_ID",
  "DRH_PROXY_ENABLED",
  "DRH_PROXY_USER",
  "DRH_PROXY_PASS",
];

const keysOf = (text: string) => parseArtifactKV(text).map(([k]) => k).sort();

describe("parser", () => {
  it("maps each var to its declared scope(s); multi-scope + container handled", () => {
    const { vars, errors } = parseScopedEnv(FIXTURE);
    expect(errors).toEqual([]);
    expect(vars).toHaveLength(23);
    const scopesOf = (k: string) => vars.find((v) => v.key === k)!.scopes.slice().sort();
    expect(scopesOf("AUTH_REQUIRED")).toEqual(["hosted-app", "mcp-drh", "mcp-rpi"]);
    expect(scopesOf("RPI_INTEGRATION_API_URL")).toEqual(["hosted-app", "mcp-rpi"]);
    expect(scopesOf("RPI_PROXY_PASS")).toEqual(["mcp-rpi"]);
    expect(scopesOf("DRH_PROXY_PASS")).toEqual(["mcp-drh"]);
    expect(scopesOf("AUTH_SECRET")).toEqual(["hosted-app"]);
    expect(scopesOf("COMPOSE_PROJECT_NAME")).toEqual(["container"]);
  });

  it("flags the 5 secrets", () => {
    const { vars } = parseScopedEnv(FIXTURE);
    const secrets = vars.filter((v) => v.secret).map((v) => v.key).sort();
    expect(secrets).toEqual([...SECRET_KEYS].sort());
  });

  it("FAILS loud on an untagged var (no #@scope block)", () => {
    const { errors } = parseScopedEnv(`FOO=bar\n`);
    expect(errors.some((e) => /orphan|no #@scope/i.test(e))).toBe(true);
  });

  it("FAILS loud on an unknown scope name", () => {
    const { errors } = parseScopedEnv(`#@scope: bogus\nFOO=bar\n`);
    expect(errors.some((e) => /unknown scope/i.test(e))).toBe(true);
  });

  it("FAILS loud on an empty #@scope tag", () => {
    const { errors } = parseScopedEnv(`#@scope:\nFOO=bar\n`);
    expect(errors.some((e) => /empty #@scope/i.test(e))).toBe(true);
  });
});

describe("generated .env.example", () => {
  it("is the full superset with every secret VALUE empty", () => {
    const { vars } = parseScopedEnv(FIXTURE);
    const out = renderEnvExample(vars);
    const kv = new Map(parseArtifactKV(out));
    // full superset
    expect([...kv.keys()].sort()).toEqual(vars.map((v) => v.key).sort());
    // secrets empty
    for (const s of SECRET_KEYS) expect(kv.get(s)).toBe("");
  });

  it("genericizes hosts and never emits a real vault value", () => {
    const { vars } = parseScopedEnv(FIXTURE);
    const out = renderEnvExample(vars);
    for (const leaked of [
      "REAL_SECRET_abc123",
      "REAL_AZURE_KEY_xyz",
      "REAL_RPI_SECRET_9999",
      "REAL_RPI_PROXY_PW",
      "REAL_DRH_PROXY_PW",
      "real-tenant.vendorcdp.com",
      "vendorcdp.com",
      "real.person@company.com",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain("https://rpi.example.com");
    expect(out).toContain("https://drh.example.com");
  });
});

describe("binary templates — exact key sets + absence", () => {
  it("mcp-rpi = exactly AUTH_REQUIRED + 8 RPI vars, secrets empty, NO foreign keys", () => {
    const { vars } = parseScopedEnv(FIXTURE);
    const tpl = renderBinaryTemplate(vars, "mcp-rpi", "RPI MCP Server");
    expect(keysOf(tpl)).toEqual([...RPI_KEYS].sort());
    // absence assertions
    for (const forbidden of ["AUTH_SECRET", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_DEPLOYMENT_ID", "DRH_API_URL", "DRH_PROXY_PASS", "INSTRUMENTATION_ENABLED", "COMPOSE_PROJECT_NAME"]) {
      expect(keysOf(tpl)).not.toContain(forbidden);
    }
    const kv = new Map(parseArtifactKV(tpl));
    expect(kv.get("RPI_OAUTH_CLIENT_SECRET")).toBe("");
    expect(kv.get("RPI_PROXY_PASS")).toBe("");
  });

  it("mcp-drh = exactly AUTH_REQUIRED + 5 DRH vars, secrets empty, NO foreign keys", () => {
    const { vars } = parseScopedEnv(FIXTURE);
    const tpl = renderBinaryTemplate(vars, "mcp-drh", "DRH MCP Server");
    expect(keysOf(tpl)).toEqual([...DRH_KEYS].sort());
    for (const forbidden of ["RPI_INTEGRATION_API_URL", "RPI_PROXY_PASS", "AZURE_OPENAI_API_KEY", "AUTH_SECRET", "COMPOSE_PROJECT_NAME"]) {
      expect(keysOf(tpl)).not.toContain(forbidden);
    }
    expect(new Map(parseArtifactKV(tpl)).get("DRH_PROXY_PASS")).toBe("");
  });

  it("re-rendering an already-rendered template does not double the secret marker", () => {
    const { vars } = parseScopedEnv(FIXTURE);
    const once = renderBinaryTemplate(vars, "mcp-rpi", "RPI MCP Server");
    const reparsed = parseScopedEnv(`#@scope: mcp-rpi\n${once}`);
    const twice = renderBinaryTemplate(reparsed.vars, "mcp-rpi", "RPI MCP Server");
    expect(twice).not.toContain("empty here)  (secret");
  });
});

describe("build-check — the security gate", () => {
  const base = () => {
    const { vars, errors } = parseScopedEnv(FIXTURE);
    return { vars, parseErrors: errors };
  };

  it("PASSES clean generated artifacts", () => {
    const { vars, parseErrors } = base();
    const artifacts = {
      ".env.example": renderEnvExample(vars),
      "mcp-rpi/.env.example": renderBinaryTemplate(vars, "mcp-rpi", "RPI"),
      "mcp-drh/.env.example": renderBinaryTemplate(vars, "mcp-drh", "DRH"),
    };
    const r = runBuildCheck({ vars, parseErrors, artifacts, sensitiveValues: sensitiveValuesFrom(FIXTURE) });
    expect(r.errors).toEqual([]);
  });

  it("FAILS if a real secret VALUE is planted into a binary output (the leak proof)", () => {
    const { vars, parseErrors } = base();
    const leaked = renderBinaryTemplate(vars, "mcp-rpi", "RPI").replace(
      "RPI_PROXY_PASS=",
      "RPI_PROXY_PASS=REAL_RPI_PROXY_PW",
    );
    const r = runBuildCheck({
      vars,
      parseErrors,
      artifacts: { "mcp-rpi/.env.example": leaked },
      sensitiveValues: sensitiveValuesFrom(FIXTURE),
    });
    expect(r.errors.length).toBeGreaterThan(0);
    // caught by BOTH the empty-secret rule and the vault-value scan
    expect(r.errors.some((e) => /secret RPI_PROXY_PASS carries a VALUE/.test(e))).toBe(true);
    expect(r.errors.some((e) => /real sensitive value from the vault/.test(e))).toBe(true);
  });

  it("FAILS if a genericized artifact still contains a real host value", () => {
    const { vars, parseErrors } = base();
    const artifacts = { ".env.example": "RPI_INTEGRATION_API_URL=https://real-tenant.vendorcdp.com/\n" };
    const r = runBuildCheck({ vars, parseErrors, artifacts, sensitiveValues: sensitiveValuesFrom(FIXTURE) });
    expect(r.errors.some((e) => /real sensitive value/.test(e))).toBe(true);
  });

  it("FAILS on an orphan/untagged var in the source", () => {
    const parsed = parseScopedEnv(`FOO=bar\n`);
    const r = runBuildCheck({ vars: parsed.vars, parseErrors: parsed.errors, artifacts: {} });
    expect(r.errors.some((e) => /orphan|no #@scope/i.test(e))).toBe(true);
  });

  it("FAILS on a cross-scope key in a binary artifact", () => {
    const { vars, parseErrors } = base();
    const artifacts = { "mcp-rpi/.env.example": "AUTH_REQUIRED=true\nDRH_API_URL=\n" };
    const r = runBuildCheck({ vars, parseErrors, artifacts });
    expect(r.errors.some((e) => /cross-scope key DRH_API_URL/.test(e))).toBe(true);
  });

  it("WARNS when code reads a var outside its declared scope", () => {
    const { vars, parseErrors } = base();
    // mcp-drh code 'reads' RPI_PROXY_PASS (tagged mcp-rpi only) → under-scope warn
    const r = runBuildCheck({
      vars,
      parseErrors,
      artifacts: {},
      codeReads: { "mcp-drh": new Set(["RPI_PROXY_PASS"]) },
    });
    expect(r.warnings.some((w) => /under-scoped.*RPI_PROXY_PASS/.test(w))).toBe(true);
  });

  it("does NOT flag the container/compose-only key as an under-scope violation", () => {
    const { vars, parseErrors } = base();
    // COMPOSE_PROJECT_NAME has no app-code read; a grep hit shouldn't warn.
    const r = runBuildCheck({
      vars,
      parseErrors,
      artifacts: {},
      codeReads: { "hosted-app": new Set(["COMPOSE_PROJECT_NAME"]) },
    });
    expect(r.warnings.some((w) => /COMPOSE_PROJECT_NAME/.test(w))).toBe(false);
  });

  it("INVARIANT: union of all scope slices == the root superset", () => {
    const { vars } = base();
    const union = new Set<string>();
    for (const scope of ["hosted-app", "mcp-rpi", "mcp-drh", "container"] as const) {
      for (const v of sliceForScope(vars, scope)) union.add(v.key);
    }
    expect([...union].sort()).toEqual(vars.map((v) => v.key).sort());
  });
});

describe("checkComposeEnv — the container config-drift guard", () => {
  const superset = new Set(["AUTH_REQUIRED", "AUTH_SECRET", "RPI_INTEGRATION_API_URL"]);
  const CLEAN = `services:
  server:
    image: rp-ai-server:1.0
    env_file: .env
    environment:
      - PORT=3000
      - SEED_RPI_MCP_URL=http://mcp-rpi:3002/mcp
    volumes:
      - server-data:/app/data
  web:
    env_file: .env
    environment:
      - NEXT_PUBLIC_API_URL=http://server:3000
      - AUTH_TRUST_HOST=true
`;

  it("PASSES clean compose: only documented value-overrides, superset via env_file", () => {
    expect(checkComposeEnv(CLEAN, superset)).toEqual([]);
  });

  it("CATCHES the real bug: a superset key (AUTH_REQUIRED) hardcoded in compose", () => {
    const broken = CLEAN.replace("      - PORT=3000", "      - PORT=3000\n      - AUTH_REQUIRED=false");
    const errs = checkComposeEnv(broken, superset);
    expect(errs.some((e) => /AUTH_REQUIRED/.test(e))).toBe(true);
  });

  it("CATCHES a key hidden only in compose (not in superset nor overrides)", () => {
    const broken = CLEAN.replace("      - PORT=3000", "      - PORT=3000\n      - SECRET_BACKDOOR=1");
    const errs = checkComposeEnv(broken, superset);
    expect(errs.some((e) => /SECRET_BACKDOOR/.test(e))).toBe(true);
  });

  it("every override key the bundle compose uses is documented in COMPOSE_OVERRIDE_KEYS", () => {
    for (const k of ["PORT", "SEED_RPI_MCP_URL", "DRH_MCP_URL", "DB_FILE_NAME", "INSTRUMENTATION_SINK_PATH", "NEXT_PUBLIC_API_URL", "AUTH_TRUST_HOST", "RPI_MCP_HTTP_PORT", "DRH_MCP_HTTP_PORT"]) {
      expect(k in COMPOSE_OVERRIDE_KEYS).toBe(true);
    }
  });
});
