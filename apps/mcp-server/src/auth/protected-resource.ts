export interface ProtectedResourceOptions {
  resource: URL;
  authorizationServer: URL;
  scopes: string[];
}

export function createProtectedResourceMetadata(options: ProtectedResourceOptions) {
  return {
    resource: options.resource.href.replace(/\/$/, ""),
    authorization_servers: [options.authorizationServer.href.replace(/\/$/, "")],
    scopes_supported: options.scopes,
    bearer_methods_supported: ["header"],
    resource_documentation: `${options.resource.href.replace(/\/$/, "")}/docs`,
  };
}

export function createBearerChallenge(resource: URL): string {
  const metadataUrl = new URL("/.well-known/oauth-protected-resource", resource);
  return `Bearer resource_metadata="${metadataUrl.href}"`;
}
