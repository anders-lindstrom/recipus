/**
 * Authentication.
 *
 * Recipus sits behind Nginx Proxy Manager, which puts Authelia in front of it
 * and then forwards the request with two things attached: a shared secret
 * proving the request really came through the proxy, and the authenticated
 * username.
 *
 * The app authenticates every request itself rather than assuming it is
 * unreachable from elsewhere. If someone ever exposes the container port by
 * accident, that mistake should produce 401s, not an open shopping list.
 *
 * Deployment note that code cannot fix: Authelia's session TTL must be long
 * (weeks, with "remember me"). This app gets opened in a shop, on bad 4G, after
 * three weeks of not being touched. A lapsed session there means a 2FA prompt
 * at the checkout — which is why the client treats a 401 as a dismissible
 * banner over a working offline list rather than a redirect. See
 * src/lib/client/session.ts.
 */

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthedUser {
  autheliaUser: string;
}

function devUser(): AuthedUser | null {
  if (process.env.NODE_ENV === "production") return null;
  const u = process.env.DEV_AUTH_USER;
  return u ? { autheliaUser: u } : null;
}

/**
 * Resolve the caller from proxy headers, or throw AuthError.
 *
 * Refuses to start in production without PROXY_AUTH_SECRET. A missing secret
 * silently disabling auth is the kind of failure that is only discovered by
 * someone else finding your shopping list, so it fails loudly instead.
 */
export function authenticate(headers: Headers): AuthedUser {
  const secret = process.env.PROXY_AUTH_SECRET;
  const userHeader = process.env.PROXY_USER_HEADER || "Remote-User";

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new AuthError(
        "PROXY_AUTH_SECRET is not set; refusing all requests.",
      );
    }
    const dev = devUser();
    if (dev) return dev;
    throw new AuthError("No PROXY_AUTH_SECRET and no DEV_AUTH_USER set.");
  }

  const presented = headers.get("x-proxy-auth");
  if (!presented || !timingSafeEqual(presented, secret)) {
    // In dev, allow the fallback user through so the app runs without a proxy.
    const dev = devUser();
    if (dev) return dev;
    throw new AuthError("Bad or missing proxy secret.");
  }

  const autheliaUser = headers.get(userHeader.toLowerCase());
  if (!autheliaUser) {
    throw new AuthError(`Proxy did not supply ${userHeader}.`);
  }

  return { autheliaUser };
}

/**
 * Constant-time string comparison.
 *
 * `===` on secrets leaks their length and prefix through timing. The cost of
 * doing this properly is four lines, so there is no reason to be clever.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
