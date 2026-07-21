export interface AuthorizationRequestInput {
  sessionHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  state?: string;
  codeChallenge: string;
  expiresAt: Date;
}

export interface PendingAuthorizationRequest {
  clientId: string;
  userId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  state?: string;
  codeChallenge: string;
}

export interface AuthorizationRequestTokens {
  requestToken: string;
  csrfToken: string;
}

export interface AuthorizationCodeInput {
  clientId: string;
  userId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  codeChallenge: string;
  expiresAt: Date;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
  resource: string;
}

export interface AuthorizationCodeExchangeInput {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  now: Date;
}

export interface RefreshTokenExchangeInput {
  refreshToken: string;
  clientId: string;
  now: Date;
}

export interface OAuthStore {
  hasGrant(userId: string, clientId: string, resource: string, scopes: string[]): boolean;
  saveGrant(userId: string, clientId: string, resource: string, scopes: string[]): void;
  createAuthorizationRequest(input: AuthorizationRequestInput): AuthorizationRequestTokens;
  consumeAuthorizationRequest(
    requestToken: string,
    csrfToken: string,
    sessionHash: string,
    now: Date,
  ): PendingAuthorizationRequest | undefined;
  createAuthorizationCode(input: AuthorizationCodeInput): string;
  exchangeAuthorizationCode(input: AuthorizationCodeExchangeInput): TokenPair | undefined;
  rotateRefreshToken(input: RefreshTokenExchangeInput): TokenPair | undefined;
}
