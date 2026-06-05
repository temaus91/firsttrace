export const entityDetailPath = (entityId: string) =>
  `/entities/${encodeURIComponent(entityId)}/detail`;

export const parseEntityId = (encodedId: string) =>
  decodeURIComponent(encodedId);
