export type AccessToken = {
  accessToken: string;
  tokenType: string;
  expiresAt: Date;
  audience: string;
  identity: string;
  scopes: string[];
};

export type OAuthClientCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
  // When set (from a route's authorized_user credentials file), the IAP token
  // is minted with this refresh token instead of the default gcloud ADC one —
  // so a custom client_id no longer requires clobbering ADC.
  readonly refreshToken?: string;
};

export type CredentialProvider = {
  get(identity: string, audience: string, scopes: string[], oauth?: OAuthClientCredentials): Promise<AccessToken>;
};
