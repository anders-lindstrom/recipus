import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthError, authenticate, isHouseholdMember } from "./auth";

/**
 * Who gets in.
 *
 * The gap these tests close is that membership used to live entirely in proxy
 * configuration, where no test could see it — and the answer it gave was
 * "whoever Authelia authenticated", which is every account on the box.
 */

const SECRET = "s".repeat(32);

function proxied(user: string, secret = SECRET): Headers {
  return new Headers({ "x-proxy-auth": secret, "remote-user": user });
}

describe("household membership", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.PROXY_AUTH_SECRET = SECRET;
    delete process.env.HOUSEHOLD_USERS;
    delete process.env.DEV_AUTH_USER;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("lets an allowlisted member in", () => {
    process.env.HOUSEHOLD_USERS = "anders,jannica";
    expect(authenticate(proxied("anders")).autheliaUser).toBe("anders");
    expect(authenticate(proxied("jannica")).autheliaUser).toBe("jannica");
  });

  it("refuses an authenticated user who is not in the household", () => {
    /*
     * The whole point. Authelia fronts every other service on the same box, so
     * before this an account made for an unrelated app could read the list —
     * and call merge_catalog_items, which tombstones a vara and permanently
     * re-points future recipe matching.
     */
    process.env.HOUSEHOLD_USERS = "anders,jannica";
    expect(() => authenticate(proxied("grafana-viewer"))).toThrow(AuthError);
  });

  it("ignores spacing and case in the allowlist", () => {
    // "Anders" and "anders " in an env var are the same person, and a mismatch
    // here would be indistinguishable from a proxy misconfiguration.
    process.env.HOUSEHOLD_USERS = " Anders , JANNICA ";
    expect(isHouseholdMember("anders")).toBe(true);
    expect(isHouseholdMember("Jannica")).toBe(true);
    expect(isHouseholdMember("mallory")).toBe(false);
  });

  it("admits everyone when unset, which is the old behaviour", () => {
    /*
     * Deliberate, and the reason is deployment rather than laxity: this app is
     * already running, and a list that failed closed would lock the household
     * out of its own shopping list on the next Watchtower pull — remotely, with
     * an SSH session as the only fix. The boundary warns instead.
     */
    expect(isHouseholdMember("anybody")).toBe(true);
  });

  it("treats an empty or whitespace allowlist as unset", () => {
    // An env var set to "" is how a deployment accidentally expresses "unset",
    // and reading it as "nobody is a member" would be a total outage.
    process.env.HOUSEHOLD_USERS = "   ";
    expect(isHouseholdMember("anders")).toBe(true);
  });

  it("still refuses a bad proxy secret before it ever considers membership", () => {
    process.env.HOUSEHOLD_USERS = "anders";
    expect(() => authenticate(proxied("anders", "wrong"))).toThrow(AuthError);
  });

  it("still refuses a request the proxy attached no user to", () => {
    process.env.HOUSEHOLD_USERS = "anders";
    const headers = new Headers({ "x-proxy-auth": SECRET });
    expect(() => authenticate(headers)).toThrow(/did not supply/i);
  });
});
