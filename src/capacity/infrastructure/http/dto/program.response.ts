/** `POST /programs`'s response. Amounts are decimal strings, never minor units. */
export interface ProgramResponse {
  readonly id: string;
  readonly ownerOrgId: string;
  readonly currency: string;
  readonly creditLimit: string;
}
