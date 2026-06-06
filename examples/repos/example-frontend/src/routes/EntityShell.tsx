type Entity = {
  id: string;
  name: string;
};

type Screen = {
  entityId: string;
  type: "entity-detail";
};

export const EntityShell = ({ entities, screen }: { entities: Entity[]; screen: Screen }) => {
  if (screen.type !== "entity-detail") return null;

  const activeEntity = entities.find((item) => item.id === screen.entityId);
  if (!activeEntity) return null;

  return <h1>{activeEntity.name}</h1>;
};
