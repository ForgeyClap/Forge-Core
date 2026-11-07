# forge-auth — OAuth 2 / OpenID Connect (social login, SSO)

Forge-native, based on RFC 9700 (OAuth 2.0 Security Best Current Practice, 2025), RFC 7636 (PKCE) and OpenID
Connect Core. The "OAuth2 / social login" pattern list of wshobson/agents (MIT) was the starting point.

## Flow
- Authorization code flow with PKCE (`code_challenge_method=S256`) for every client, confidential ones included.
- Generate `state` per login attempt, store it in the user's session (or a short-lived `HttpOnly` cookie), compare
  on callback, then discard it. For OIDC also send a `nonce` and check it in the ID token.
- Do not use the implicit flow or the resource-owner password grant.
- Exchange the code on the server; a confidential client keeps its secret on the server only.

## Redirect URIs
- Register exact redirect URIs (no wildcards, no open path prefixes); one per environment.
- After login, redirect only to allow-listed relative paths; never to a full URL taken from a query parameter.

## Tokens from the provider
- Validate the ID token (signature via the provider's JWKS, `iss`, `aud` = your client ID, `exp`, `nonce`).
- Identify the user by the stable pair (`iss`, `sub`), never by email alone. Emails change and some providers
  return unverified emails.
- Request the minimum scopes; store provider access/refresh tokens only if the app calls the provider's API,
  encrypted at rest.

## Account linking
- Auto-link a social login to an existing account only when the provider asserts a verified email AND that
  provider is trusted for it; otherwise require the user to sign in to the existing account first. Careless
  linking lets an attacker who controls an unverified email take over an account.

## Enterprise SSO
- SAML/OIDC per tenant: map the IdP to a tenant, enforce that users of a verified domain sign in through it,
  and handle de-provisioning (SCIM or regular sync) so removed employees lose access.
