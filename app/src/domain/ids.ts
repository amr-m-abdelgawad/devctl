declare const serviceIdBrand: unique symbol;
declare const profileIdBrand: unique symbol;
declare const identityIdBrand: unique symbol;
declare const portBrand: unique symbol;

export type ServiceId = string & { readonly [serviceIdBrand]: "ServiceId" };
export type ProfileId = string & { readonly [profileIdBrand]: "ProfileId" };
export type IdentityId = string & { readonly [identityIdBrand]: "IdentityId" };
export type Port = number & { readonly [portBrand]: "Port" };

export function serviceId(value: string): ServiceId {
  return value as ServiceId;
}

export function profileId(value: string): ProfileId {
  return value as ProfileId;
}
