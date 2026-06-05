export const loadEntitySummary = async (entityId: string) => {
  const response = await fetch(`/api/entities/${entityId}/summary`);
  if (!response.ok) throw new Error("Entity summary request failed");
  return response.json() as Promise<{ id: string; summary: string }>;
};
